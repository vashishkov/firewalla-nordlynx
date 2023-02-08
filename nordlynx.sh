#/bin/bash
private_key=
profile_path=/home/pi/.firewalla/run/wg_profile
name=Lynx

while getopts 'c:m:l:' option; do
  case "$option" in
    c)
        country=$OPTARG
      ;;
    m)
        max_load=$OPTARG
      ;;
    l)
  limit=$OPTARG
      ;;
    *)
        printf 'ERROR: Invalid argument\n' >&2
        exit 1
      ;;
  esac
done
shift $((OPTIND-1))

[[ ! -z max_load ]] && max_load=75
[[ ! -z limit ]] && limit=1

if [[ ! -z $country ]]; then
  params="filters\[servers_technologies\]\[identifier\]=wireguard_udp&filters\[country_id\]=$country"
  name+=$country
else
  params="filters\[servers_technologies\]\[identifier\]=wireguard_udp"
  name+=0
fi
state_file="/tmp/$name"

api=`curl -s "https://api.nordvpn.com/v1/servers/recommendations?$params&limit=$limit"`
recommended_server=`echo $api | jq -r 'sort_by(.load)[0]|.hostname'`

if [[ ! -f "$profile_path/$name.conf" || ! -f "$profile_path/$name.settings" || ! -f "$profile_path/$name.json" ]]; then 
  update_conf=true
fi

if [[ ! -f $state_file ]]; then 
  touch $state_file
  echo $recommended_server > $state_file
  server=$recommended_server
else
  server=`cat $state_file`
fi

if [[ $server != $recommended_server ]]; then
  load=`curl -s -m 10 "https://api.nordvpn.com/server/stats/$server" | jq -r '.percent'`
  rec_server_load=`curl -s -m 10 "https://api.nordvpn.com/server/stats/$recommended_server" | jq -r '.percent'`
  if [[ $load -gt $max_load && $load -gt $rec_server_load ]]; then
    echo "Current server load is above $max_load%. Swapping server from current $server to recommended $recommended_server."
    echo $recommended_server > $state_file
    server=$recommended_server
    load=$rec_server_load
    update_conf=true
  fi
fi

if [[ ! -z $update_conf ]]; then
  echo "Generating/updating VPN config files"
  publickey=`echo $api | jq -r 'sort_by(.load)[0]|(.technologies|.[].metadata|.[].value)'`
  endpoint=`echo $api | jq -r 'sort_by(.load)[0]|.station'`
  port="51820"

  cat >"$profile_path/$name.conf" <<EOF
[Interface]
PrivateKey = $private_key
[Peer]
PersistentKeepalive = 20
PublicKey = $publickey
AllowedIPs = 0.0.0.0/0
Endpoint = $endpoint:$port
EOF
  cat >"$profile_path/$name.settings" <<EOF
{
  "serverSubnets": [],
  "overrideDefaultRoute": true,
  "routeDNS": false,
  "strictVPN": false,
  "displayName": "$name",
  "createdDate": `date +"%s.%5N"`,
  "serverVPNPort": $port,
  "subtype": "wireguard",
  "serverDDNS": "$endpoint"
}
EOF
  cat >"$profile_path/$name.json" <<EOF
{
  "peers": [
    {
      "publicKey": "$publickey",
      "endpoint": "$endpoint:$port",
      "persistentKeepalive": "20",
      "allowedIPs": [
        "0.0.0.0/0"
      ]
    }
  ],
  "addresses": [
    "10.5.0.2/24"
  ],
  "privateKey": "$private_key",
  "dns": [
    "1.1.1.1"
  ]
}
EOF
fi

if [[ -d "/sys/class/net/vpn_$name" && ! -z $update_conf ]]; then
        echo "interface vpn_$name exists. Update config"
        sudo wg syncconf vpn_$name $profile_path/$name.conf
elif [[ ! -z $update_conf ]]; then
        echo "interface vpn_$name not exists. Creating"
        sudo ip link add dev vpn_$name type wireguard
        sudo wg setconf vpn_$name $profile_path/$name.conf
fi