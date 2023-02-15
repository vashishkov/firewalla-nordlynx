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
// const profilePath = '/tmp/'
const api = {
    baseUrl: 'https://api.nordvpn.com',
    statsPath: '/server/stats',
    serversPath: '/v1/servers',
}
const params = {
    privateKey: config.privateKey
}

'use strict'

async function  apiRequest(path, filters=null, limit=false) {
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

    return await rp.get(options)
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
        "peers": [{
        "publicKey": params.pubkey,
        "endpoint": `${params.station}:51820`,
        "persistentKeepalive": "20",
        "allowedIPs": ["0.0.0.0/0"]}],
        "addresses": ["10.5.0.2/24"],
        "privateKey": params.privateKey,
        "dns": ["1.1.1.1"]
    }
    try {
        var settings, event = await readFileAsync(`${profilePath + fileName}.settings`, {encoding: 'utf8'})
        .then((result) => {
            settings = JSON.parse(result)
            if (params.station == settings.serverDDNS) {
                var event = null
            } else {
                settings.displayName = displayName
                settings.serverDDNS = params.station
                var event = {
                    "type": "VPNClient:SettingsChanged",
                    "profileId": fileName,
                    "settings": settings,
                    "fromProcess": "VPNClient"
                }
            }
            return settings, event
    })
    } catch (err) {
        var settings = {
            "serverSubnets": [],
            "overrideDefaultRoute": true,
            "routeDNS": false,
            "strictVPN": true,
            "displayName": displayName,
            "createdDate": `${Date.now() / 1000}`,
            "serverVPNPort": 51820,
            "subtype": "wireguard",
            "serverDDNS": params.station
        }
    }

    writeFileAsync(`${profilePath + fileName}.conf`, conf, { encoding: 'utf8' })
    writeFileAsync(`${profilePath + fileName}.settings`, JSON.stringify(settings), {encoding: 'utf8'})
    writeFileAsync(`${profilePath + fileName}.json`, JSON.stringify(profile), {encoding: 'utf8'})
    fs.stat(`/sys/class/net/vpn_${fileName}`, function(err, stat) {
        if (err) {
            console.log(`${fileName}:\tcreating VPN Interface.`)
            exec(`sudo ip link add dev vpn_${fileName} type wireguard`)
            exec(`sudo ip link set vpn_${fileName} mtu 1412`)
            profile.addresses.forEach(ip => {
                exec(`sudo ip addr add ${ip} dev vpn_${fileName}`)
            })
            exec(`sudo wg setconf vpn_${fileName} ${profilePath + fileName}.conf`)
        } else if (event) {
            console.log(`${displayName}:\tendpoint changed to ${params.hostname}. Refreshing routes.`)
            exec(`sudo wg syncconf vpn_${fileName} ${profilePath + fileName}.conf`)
            exec(`redis-cli PUBLISH TO.FireMain '${JSON.stringify(event)}'`)
        } else {
            console.log(`${displayName}:\tnothing to do. Server ${params.hostname} is still recommended one.`)
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
    .then((result) => {
        params.pubkey = result[0].technologies.find(o => o.identifier === 'wireguard_udp').metadata[0].value
        params.countryid = countryId
        if (countryId != 0) {
            params.country = result[0].locations[0].country.name
        } else {
            params.country = 'Nord Quick'
        }
        params.city = result[0].locations[0].country.city.name
        params.hostname = result[0].hostname
        params.station = result[0].station

        return params
    })
}

if (config.recommended) {
    getProfile(0)
    .then((result) => {
        generateVPNConfig(result)
    })
}

apiRequest(api.serversPath + '/countries')
.then((result) => {
    config.countries.forEach(item => {
        var country = result.find(o => o.name === item)
        getProfile(country.id)
        .then((result) => {
            generateVPNConfig(result)
        })
    })
})