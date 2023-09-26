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

How it work:

1. If no VPN clients exist, create them from the configuration.
2. Compares the current server to the recommended server.
3. Check the load on the current server if it is not the recommended server.
4. If the load is below a certain threshold, the server rotation is skipped. If the load exceeds the threshold, replace the current server with the recommended one and trigger FireMain process to refresh routes.

Available countries:

```
curl --silent "https://api.nordvpn.com/v1/servers/countries" | jq --raw-output '.[] | [.id, .name] | @tsv'
```
