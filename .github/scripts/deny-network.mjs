// Fail locally when the core CLI attempts Node network I/O.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
const deny = () => { throw new Error('OFFLINE_CORE_NETWORK_DENIED'); };
net.Socket.prototype.connect = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
dns.lookup = deny; dns.resolve = deny; globalThis.fetch = deny;
