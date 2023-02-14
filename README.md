1. Save into `~/scripts/`
2. Add desired counties and Nordlynx private key to `~/scripts/nordconf.json`
3. Add crontab entry:
```
echo "1 * * * * NODE_PATH=/home/pi/.node_modules/node_modules/ node /home/pi/scripts/nordlynx.js" >> ~/.firewalla/config/user_crontab
```
or run manually:
```
NODE_PATH=/home/pi/.node_modules/node_modules/ node /home/pi/scripts/nordlynx.js
```

TODO: 
1. Check the active server load and swap it to next recommended server only if the load is above the desired threshold.

Available countries: 
```
curl --silent https://api.nordvpn.com/server | jq --raw-output '[.[].country] | sort | unique | .[]'
```