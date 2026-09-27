import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/service.js';
import { AddressService } from '../addresses/service.js';
import { FileBlobStore } from '../blob-store.js';
import { createOutboundDependencies } from '../outbound-integration.js';
import { OutboundService, CloudflareRawTransport, loadOutboundConfig, runOneOutboundJob } from '../outbound/index.js';
const {values}=parseArgs({options:{once:{type:'boolean',default:false}}});
const config=loadConfig(),outbound=config.outbound??loadOutboundConfig({});
if(!config.auth||!config.addresses)throw new Error('Outbound jobs require SSO and configured address authority');
const pool=new pg.Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000});
const auth=new AuthService(pool,config.auth),addresses=new AddressService(pool,config.addresses,(id,client)=>auth.resolvePrincipal(id,client));
const deps=createOutboundDependencies(config,pool,auth,addresses,new FileBlobStore(config.mailStorePath));
if(outbound.enabled)deps.transport=new CloudflareRawTransport(outbound);
const service=new OutboundService(pool,outbound,deps);
let stopping=false;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
try{let count=0;while(!stopping){const worked=await runOneOutboundJob(service);if(worked)count++;if(values.once&&(!worked||count>=100))break;if(!worked)await setTimeout(1000);}console.log('Outbound job runner stopped.');}
catch{console.error('Outbound job runner failed. Durable submissions remain available and uncertain attempts will not be resent automatically.');process.exitCode=1;}
finally{await pool.end();}
