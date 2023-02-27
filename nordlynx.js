#!/usr/bin/env node

const Promise = require('bluebird')
const rp = require('request-promise')
const fs = require('fs')
const readFileAsync = Promise.promisify(fs.readFile)
const writeFileAsync = Promise.promisify(fs.writeFile)
const exec = require('child-process-promise').exec
const config = JSON.parse(fs.readFileSync(`${__dirname}/nordconf.json`))
const netif = 'lynx'
const profilePath = '/home/pi/.firewalla/run/wg_profile/'
const api = {
    baseUrl: 'https://api.nordvpn.com',
    statsPath: '/server/stats/',
    serversPath: '/v1/servers/',
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
    var profileId = netif + params.countryid
    var displayName = `${params.country} (${params.city})`
    var profile = {
        peers: [{
            publicKey: params.pubkey,
            endpoint: `${params.station}:51820`,
            persistentKeepalive: 20,
            allowedIPs: ["0.0.0.0/0"]
        }],
        addresses: ["10.5.0.2/24"],
        privateKey: config.privateKey,
        dns: ["1.1.1.1"]
    }
    var defaultSettings = {
        subtype: 'wireguard',
        profileId: profileId,
        deviceCount: 0,
        load: {percent: 0},
        displayName: displayName,
        serverName: params.hostname,
        serverSubnets: [],
        overrideDefaultRoute: true,
        routeDNS: false,
        strictVPN: true,
        createdDate: Date.now() / 1000
    }
    try {
        fs.accessSync(`/sys/class/net/vpn_${profileId}`)
    } catch (err) {
        if (err.code == 'ENOENT') {
            var netifNotExist = true
        }
    }
    try {
        fs.statSync(`${profilePath + profileId}.json`)
        var settings = JSON.parse(await readFileAsync(`${profilePath + profileId}.settings`, {encoding: 'utf8'}))
    } catch (err) {
        if (err.code == 'ENOENT') {
            var configCreated = true
            var settings = defaultSettings
        }
    }
    var brokerEvent = {
        type: "VPNClient:SettingsChanged",
        profileId: profileId,
        settings: settings,
        fromProcess: "VPNClient"
    }
    if (settings.serverName != params.hostname) {
        settings.load = await serverLoad(settings.serverName)
        if (settings.load.percent > config.maxLoad && settings.load.percent > params.load) {
            if (config.debug) {
                console.log(`${params.country}:\tServer changed from ${settings.serverName} (load ${settings.load.percent}%) to ${params.hostname} (load ${params.load}%).`)
            }
            var configUpdated = true
            settings.displayName = displayName
            settings.serverName = params.hostname
            settings.serverDDNS = params.station
            settings.load.percent = params.load
            settings.createdDate = Date.now() / 1000
        } else {
            if (config.debug) {
                console.log(`${params.country}:\tServer ${settings.serverName} (load ${settings.load.percent}%) is still recommended one.`)
            }
        }
    } else {
        if (config.debug) {
            console.log(`${params.country}:\tServer ${settings.serverName} is still recommended one.`)
        }
    }
    if (configCreated || configUpdated) {
        await writeFileAsync(`${profilePath + profileId}.settings`, JSON.stringify(settings), { encoding: 'utf8' })
        await writeFileAsync(`${profilePath + profileId}.json`, JSON.stringify(profile), { encoding: 'utf8' })
    }
    if (netifNotExist) {
        var cmd = []
        if (config.debug) {
            console.log(`${params.country}:\tCreating vpn_${profileId} interface.`)
        }
        cmd.push(`sudo ip link add dev vpn_${profileId} type wireguard`)
        cmd.push(`sudo ip link set vpn_${profileId} mtu 1412`)
        profile.addresses.forEach(ip => {
            cmd.push(`sudo ip addr add ${ip} dev vpn_${profileId}`)
        });
        exec(cmd.join('&&'))
    }
    if (configUpdated || configCreated || netifNotExist) {
        if (config.debug) {
            console.log(`${params.country}:\tRefreshing routes for vpn_${profileId} interface.`)
        }
        exec(`redis-cli PUBLISH TO.FireMain '${JSON.stringify(brokerEvent)}'`)
    }
}

async function getProfile(countryId) {
    var path = api.serversPath + 'recommendations'
    var filters = ['[servers_technologies][identifier]=wireguard_udp']
    if (countryId != 0) {
        filters.push(`[country_id]=${countryId}`)
    }

    return await apiRequest(path, filters, true)
    .then((res, err) => {
        if (!err) {
            var params = {}
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
    var countryList = await apiRequest(api.serversPath + 'countries')
    for await (var item of config.countries) {
        var country = countryList.find(o => o.name === item)
        var profile = await getProfile(country.id)
        await generateVPNConfig(profile)
    }
}

main();