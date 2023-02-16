#!/usr/bin/env node

const Promise = require('bluebird')
const rp = require('request-promise')
const fs = require('fs')
const readFileAsync = Promise.promisify(fs.readFile)
const writeFileAsync = Promise.promisify(fs.writeFile)
const exec = require('child-process-promise').exec
const config = JSON.parse(fs.readFileSync(`${__dirname}/nordconf.json`))
const netif = 'nordlynx'
const profilePath = '/home/pi/.firewalla/run/wg_profile/'
const api = {
    baseUrl: 'https://api.nordvpn.com',
    statsPath: '/server/stats/',
    serversPath: '/v1/servers',
}
const params = {
    privateKey: config.privateKey
}

'use strict'

async function apiRequest(path, filters = null, limit = false) {
    var url = api.baseUrl + path
    if (filters) {
        url += `?filters${filters.join('&filters')}`
    }
    if (limit) {
        url += `&limit=${config.limit}`
    }
    var options = {
        url: url,
        json: true
    }
    return await rp.get(options);
}

async function serverLoad(server) {
    return await apiRequest(api.statsPath + server)
}

async function generateVPNConfig(params) {
    var fileName = netif + params.countryid
    var displayName = `${params.country} (${params.city})`
    var conf =
        `[Interface]
         PrivateKey = ${params.privateKey}
         [Peer]
         PublicKey = ${params.pubkey}
         Endpoint = ${params.station}:51820
         PersistentKeepalive = 20`
    var profile = {
        peers: [{
            publicKey: params.pubkey,
            endpoint: `${params.station}:51820`,
            persistentKeepalive: 20,
            allowedIPs: ["0.0.0.0/0"]
        }],
        addresses: ["10.5.0.2/24"],
        privateKey: params.privateKey,
        dns: ["1.1.1.1"]
    }
    try {
        var settings = JSON.parse(await readFileAsync(`${profilePath + fileName}.settings`, {encoding: 'utf8'}))
    } catch (err) {
        var createConfig = true
        var settings = {
            displayName: displayName,
            serverName: params.hostname,
            serverSubnets: [],
            overrideDefaultRoute: true,
            routeDNS: false,
            strictVPN: true,
            createdDate: Date.now() / 1000
        }
    }
    var event = {
        type: "VPNClient:SettingsChanged",
        profileId: fileName,
        settings: settings,
        fromProcess: "VPNClient"
    }
    if (settings.serverName != params.hostname) {
        settings.load = await serverLoad(settings.serverName)
        if (params.load < config.maxLoad < settings.load.percent || 100) {
            var updateConfig = true
            settings.displayName = displayName
            settings.serverName = params.hostname
            settings.serverDDNS = params.station
        }
    }
    if (createConfig || updateConfig) {
        await writeFileAsync(`${profilePath + fileName}.conf`, conf, { encoding: 'utf8' })
        await writeFileAsync(`${profilePath + fileName}.settings`, JSON.stringify(settings), { encoding: 'utf8' })
        await writeFileAsync(`${profilePath + fileName}.json`, JSON.stringify(profile), { encoding: 'utf8' })
    }
    fs.stat(`/sys/class/net/vpn_${fileName}`, function(err, stat) {
        if (!err) {
            var inetifExists = true
        }
        if (!inetifExists) {
            exec(`sudo ip link add dev vpn_${fileName} type wireguard`)
            exec(`sudo ip link set vpn_${fileName} mtu 1412`)
            profile.addresses.forEach(ip => {
                exec(`sudo ip addr add ${ip} dev vpn_${fileName}`)
            })
        } else if (createConfig) {
            if (config.debug) {
                console.log(`${displayName}:\tClient created`)
            }
            exec(`sudo wg setconf vpn_${fileName} ${profilePath + fileName}.conf`)
        } else if (updateConfig) {
            if (config.debug) {
                console.log(`${displayName}:\tClient changed. Refreshing routes.`)
            }
            exec(`sudo wg syncconf vpn_${fileName} ${profilePath + fileName}.conf`)
            exec(`redis-cli PUBLISH TO.FireMain '${JSON.stringify(event)}'`)
        } else {
            if (config.debug) {
                console.log(`${displayName}:\tNothing to do. Server is still recommended one.`)
            }
        }
    });
}

async function getProfile(countryId) {
    var path = `${api.serversPath}/recommendations`
    var filters = ['[servers_technologies][identifier]=wireguard_udp']
    if (countryId != 0) {
        filters.push(`[country_id]=${countryId}`)
    }

    return await apiRequest(path, filters, true)
    .then((res, err) => {
        if (!err) {
            params.pubkey = res[0].technologies.find(o => o.identifier === 'wireguard_udp').metadata[0].value
            params.countryid = countryId
            if (countryId != 0) {
                params.country = res[0].locations[0].country.name
            } else {
                params.country = 'Nord Quick'
            }
            params.city = res[0].locations[0].country.city.name
            params.hostname = res[0].hostname
            params.station = res[0].station
            params.load = res[0].load
            
            return params;
        }
    })
}

async function main() {
    if (config.recommended || false) {
        var quickProfile = await getProfile(0)
        await generateVPNConfig(quickProfile)
    }
    var countryList = await apiRequest(api.serversPath + '/countries')
    for await (var item of config.countries) {
        var country = countryList.find(o => o.name === item)
        var profile = await getProfile(country.id)
        await generateVPNConfig(profile)
    }
}

main();