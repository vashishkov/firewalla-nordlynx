#!/usr/bin/env node

const Promise = require("bluebird");
const rp = require("request-promise");
const fs = require("fs");
const readFileAsync = Promise.promisify(fs.readFile);
const writeFileAsync = Promise.promisify(fs.writeFile);
const exec = require("child-process-promise").exec;
const config = JSON.parse(fs.readFileSync(`${__dirname}/nordconf.json`));
const netif = "lynx";
const profilePath = "/home/pi/.firewalla/run/wg_profile/";
const api = {
  baseUrl: "https://api.nordvpn.com",
  statsPath: "/server/stats/",
  serversPath: "/v1/servers/",
};

("use strict");

async function apiRequest(path, filters = null, limit = false) {
  var url = api.baseUrl + path;
  if (filters) {
    url += `?filters${filters.join("&filters")}`;
  }
  if (limit) {
    url += `&limit=${config.limit}`;
  }
  var options = {
    url: url,
    json: true,
  };
  return await rp.get(options);
}

async function serverLoad(server) {
  return await apiRequest(api.statsPath + server);
}

async function generateVPNConfig(params) {
  var profileId = netif + params.countryid;
  var displayName = `${params.country} (${params.city})`;
  var profile = {
    peers: [
      {
        publicKey: params.pubkey,
        endpoint: `${params.station}:51820`,
        persistentKeepalive: 20,
        allowedIPs: ["0.0.0.0/0"],
      },
    ],
    addresses: [params.ip],
    privateKey: config.privateKey,
    dns: ["1.1.1.1"],
  };
  var defaultSettings = {
    subtype: "wireguard",
    profileId: profileId,
    deviceCount: 0,
    load: { percent: 0 },
    displayName: displayName,
    serverName: params.hostname,
    serverSubnets: [],
    overrideDefaultRoute: true,
    routeDNS: false,
    strictVPN: true,
    createdDate: Date.now() / 1000,
  };
  try {
    fs.statSync(`${profilePath + profileId}.json`);
    var settings = JSON.parse(
      await readFileAsync(`${profilePath + profileId}.settings`, {
        encoding: "utf8",
      }),
    );
  } catch (err) {
    if (err.code == "ENOENT") {
      var configCreated = true;
      var settings = defaultSettings;
    }
  }
  try {
    fs.statSync(`/sys/class/net/vpn_${profileId}`);
  } catch (err) {
    if (err.code == "ENOENT") {
      var netifDown = true;
    }
  }
  var brokerEvent = {
    type: "VPNClient:SettingsChanged",
    profileId: profileId,
    settings: settings,
    fromProcess: "VPNClient",
  };
  if (settings.serverName != params.hostname && !netifDown) {
    settings.load = await serverLoad(settings.serverName);
    if (
      settings.load.percent > config.maxLoad &&
      settings.load.percent > params.load
    ) {
      if (config.debug) {
        console.log(
          `${settings.serverName} (load ${settings.load.percent}%) changed to ${params.hostname} (load ${params.load}%).`,
        );
      }
      var configUpdated = true;
      settings.displayName = displayName;
      settings.serverName = params.hostname;
      settings.serverDDNS = params.station;
      settings.load.percent = params.load;
      settings.createdDate = Date.now() / 1000;
    } else {
      if (config.debug) {
        console.log(
          `${settings.serverName} (load ${settings.load.percent}%) is still recommended.`,
        );
      }
    }
  } else {
    if (config.debug) {
      console.log(`${settings.serverName} is still recommended.`);
    }
  }
  if (configCreated || configUpdated) {
    await writeFileAsync(
      `${profilePath + profileId}.settings`,
      JSON.stringify(settings),
      { encoding: "utf8" },
    );
    await writeFileAsync(
      `${profilePath + profileId}.json`,
      JSON.stringify(profile),
      { encoding: "utf8" },
    );
  }
  if (configUpdated || configCreated) {
    if (config.debug) {
      console.log(
        `refreshing routes for ${settings.serverName} (load ${settings.load.percent}%).`,
      );
    }
    exec(`redis-cli PUBLISH TO.FireMain '${JSON.stringify(brokerEvent)}'`);
  }
}

async function getProfile(countryId) {
  var path = api.serversPath + "recommendations";
  var filters = ["[servers_technologies][identifier]=wireguard_udp"];
  if (countryId != 0) {
    filters.push(`[country_id]=${countryId}`);
  }

  return await apiRequest(path, filters, true).then((res, err) => {
    if (!err) {
      var params = {};
      if (config.limit > 1) {
        server = res.sort((a, b) => parseFloat(a.load) - parseFloat(b.load))[0];
      } else {
        server = res[0];
      }
      params.pubkey = server.technologies.find(
        (o) => o.identifier === "wireguard_udp",
      ).metadata[0].value;
      params.countryid = countryId;
      if (countryId != 0) {
        params.country = server.locations[0].country.name;
        params.ip = `10.5.0.${countryId}/24`; // TODO: make octet unique, not country id
      } else {
        params.country = "Quick";
        params.ip = `10.5.0.5/24`;
      }
      params.city = server.locations[0].country.city.name;
      params.hostname = server.hostname;
      params.station = server.station;
      params.load = server.load;

      return params;
    }
  });
}

async function main() {
  if (config.recommended || false) {
    var quickProfile = await getProfile(0);
    await generateVPNConfig(quickProfile);
  }
  var countryList = await apiRequest(api.serversPath + "countries");
  for await (var item of config.countries) {
    var country = countryList.find((o) => o.name === item);
    var profile = await getProfile(country.id);
    await generateVPNConfig(profile);
  }
}

main();
