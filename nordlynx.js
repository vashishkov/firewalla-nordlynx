#!/usr/bin/env node
const Promise = require("bluebird");
const rp = require("request-promise");
const fs = require("fs");
const exec = require("child-process-promise").exec;
const config = JSON.parse(fs.readFileSync(`${__dirname}/nordconf.json`));
const netif = "lynx";
const profilePath = "/home/pi/.firewalla/run/wg_profile/";
const api = {
  baseUrl: "https://api.nordvpn.com",
  serversPath: "/v1/servers/",
};

("use strict");

const readFileAsync = Promise.promisify(fs.readFile);
const writeFileAsync = Promise.promisify(fs.writeFile);

async function apiRequest(path, filters = null, limit = false) {
  let url = api.baseUrl + path;
  if (filters) {
    url += `?filters${filters.join("&filters")}`;
  }
  if (limit) {
    url += `&limit=${config.limit}`;
  }
  const options = { url, json: true };
  try {
    return await rp.get(options);
  } catch (err) {
    console.error("API Request Failed:", err);
    throw err; // Rethrow the error for caller to handle
}
}

async function readOrCreateFiles(profileId, defaultSettings, defaultProfile) {
  const settingsPath = `${profilePath + profileId}.settings`;
  const profileFilePath = `${profilePath + profileId}.json`;

  let settings, profile;

  try {
    const settingsData = await readFileAsync(settingsPath, 'utf8');
    settings = JSON.parse(settingsData);
  } catch (err) {
    if (err.code === "ENOENT") {
      await writeFileAsync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
      settings = defaultSettings;
    } else {
      throw err;
    }
  }

  try {
    const profileData = await readFileAsync(profileFilePath, 'utf8');
    profile = JSON.parse(profileData);
  } catch (err) {
    if (err.code === "ENOENT") {
      await writeFileAsync(profileFilePath, JSON.stringify(defaultProfile), 'utf8');
      profile = defaultProfile;
    } else {
      throw err;
    }
  }

  return { settings, profile };
}

async function saveSettingsAndProfile(profileId, settings, profile) {
  const settingsFilePath = `${profilePath + profileId}.settings`;
  const profileFilePath = `${profilePath + profileId}.json`;

  console.log(`Saving settings to ${settingsFilePath}`);
  await writeFileAsync(settingsFilePath, JSON.stringify(settings), 'utf8');

  console.log(`Saving profile to ${profileFilePath}`);
  await writeFileAsync(profileFilePath, JSON.stringify(profile), 'utf8');
}

async function generateVPNConfig(params) {
  const profileId = netif + params.countryid;
  const displayName = `${params.country} (${params.hostname})`;
  
  const createdProfile = createProfile(params, config.privateKey);
  const defaultSettings = createDefaultSettings(displayName, profileId, params);

  await ensureDirectoryExists(profilePath);

  const { settings, profile } = await readOrCreateFiles(profileId, defaultSettings, createdProfile);

  const netifDown = !(await doesInterfaceExist(profileId));
  const brokerEvent = createBrokerEvent(profileId, settings);

  if (await shouldUpdateConfig(settings, params, netifDown)) {
    updateSettings(settings, params, displayName);
    await writeFileAsync(`${profilePath + profileId}.settings`, JSON.stringify(settings), 'utf8');
    await writeFileAsync(`${profilePath + profileId}.json`, JSON.stringify(profile), 'utf8');
    await publishBrokerEvent(brokerEvent);
  }
}

async function ensureDirectoryExists(path) {
  if (!fs.existsSync(path)) {
    await fs.promises.mkdir(path, { recursive: true });
  }
}

function createProfile(params, privateKey) {
  return {
    peers: [{
      publicKey: params.pubkey,
      endpoint: `${params.station}:51820`,
      persistentKeepalive: 20,
      allowedIPs: ["0.0.0.0/0"]
    }],
    addresses: [params.ip],
    privateKey: privateKey,
    dns: ["1.1.1.1"]
  };
}

async function getProfile(countryId) {
  try {
    const path = api.serversPath + "recommendations";
    const filters = ["[servers_technologies][identifier]=wireguard_udp"];
    if (countryId !== 0) {
      filters.push(`[country_id]=${countryId}`);
    }

    const response = await apiRequest(path, filters, true);
    const server = (config.limit > 1) 
      ? response.sort((a, b) => parseFloat(a.load) - parseFloat(b.load))[0]
      : response[0];

    const pubkey = server.technologies.find(o => o.identifier === "wireguard_udp").metadata[0].value;
    
    return {
      pubkey: pubkey,
      countryid: countryId,
      country: (countryId !== 0) ? server.locations[0].country.name : "Quick",
      ip: (countryId !== 0) ? `10.5.0.${countryId}/24` : `10.5.0.5/24`, // Modify IP logic as needed
      hostname: server.hostname,
      station: server.station,
      load: server.load
    };
  } catch (err) {
    console.error("Error fetching profile:", err);
    throw err;
  }
}

function createDefaultSettings(displayName, profileId, params) {
  return {
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
    createdDate: Date.now() / 1000
  };
}

async function doesInterfaceExist(profileId) {
  try {
    await fs.promises.access(`/sys/class/net/vpn_${profileId}`);
    return true;
  } catch (err) {
    return false;
  }
}

function createBrokerEvent(profileId, settings) {
  return {
    type: "VPNClient:SettingsChanged",
    profileId: profileId,
    settings: settings,
    fromProcess: "VPNClient"
  };
}

async function shouldUpdateConfig(settings, params, netifDown) {
  if (!netifDown && settings.serverName !== params.hostname) {
    console.log(`Updating configuration: Current server ${settings.serverName} is different from recommended server ${params.hostname}`);
    return true;
  }
  console.log(`No update needed: Current server ${settings.serverName} is the recommended server for ${params.country}`);
  return false;
}

function updateSettings(settings, params, displayName) {
  settings.displayName = displayName;
  settings.serverName = params.hostname;
  settings.serverDDNS = params.station;
  settings.load.percent = params.load;
  settings.createdDate = Date.now() / 1000;
}

async function publishBrokerEvent(brokerEvent) {
  await exec(`redis-cli PUBLISH TO.FireMain '${JSON.stringify(brokerEvent)}'`);
}

async function main() {
  console.log("Starting VPN configuration process");

  try {
    if (config.recommended) {
      console.log("Fetching profile for recommended server");
      const recommendedProfile = await getProfile(0);
      await generateVPNConfig(recommendedProfile);
    }

    const desiredCountries = config.countries;
    console.log(`Configuring VPN for countries: ${desiredCountries.join(', ')}`);
    const countryList = await apiRequest(api.serversPath + "countries");

    for (const countryName of desiredCountries) {
      const country = countryList.find(o => o.name === countryName);
      if (country) {
        console.log(`Fetching profile for country: ${countryName}`);
        const profile = await getProfile(country.id);
        await generateVPNConfig(profile);
      } else {
        console.log(`Country not found: ${countryName}`);
      }
    }

    console.log("VPN configuration process completed");
  } catch (err) {
    console.error("An error occurred in the main function:", err);
  }
}

main().catch(err => {
  console.error("Unhandled error:", err);
});