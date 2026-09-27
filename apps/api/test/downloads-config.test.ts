import { describe,it,expect } from 'vitest';
import { loadDownloadConfig } from '../src/downloads/config.js';

const env={DOWNLOAD_ORIGIN:'https://download.example.co.uk',ATTACHMENT_PREVIEW_ORIGIN:'https://preview.example.net',
  DOWNLOAD_KEY_ID:'download-test',DOWNLOAD_SECRET:'test-download-secret-at-least-32-characters'};
describe('download origin and operational configuration',()=>{
  it('does not enable the feature without explicit download configuration',()=>{
    expect(loadDownloadConfig({},'https://mail.example.co.uk','/tmp/mail')).toBeUndefined();
  });
  it('understands registrable domains and allows configured operational bounds',()=>{
    const config=loadDownloadConfig({...env,DOWNLOAD_SESSION_TTL_SECONDS:'900',ATTACHMENT_STAGE_MAX_BYTES:'33554432'},'https://mail.example.co.uk','/tmp/mail');
    expect(config?.sessionTtlSeconds).toBe(900);expect(config?.stageMaxBytes).toBe(33554432);
  });
  it('rejects a different registrable site, including private public suffixes',()=>{
    expect(()=>loadDownloadConfig({...env,DOWNLOAD_ORIGIN:'https://download.other.co.uk'},'https://mail.example.co.uk','/tmp/mail')).toThrow(/same HTTPS site/);
    expect(()=>loadDownloadConfig({...env,DOWNLOAD_ORIGIN:'https://other.github.io'},'https://user.github.io','/tmp/mail')).toThrow(/same HTTPS site/);
  });
  it('requires distinct hostnames and a separate preview site',()=>{
    expect(()=>loadDownloadConfig({...env,DOWNLOAD_ORIGIN:'https://mail.example.co.uk:9443'},'https://mail.example.co.uk','/tmp/mail')).toThrow(/distinct hostnames/);
    expect(()=>loadDownloadConfig({...env,ATTACHMENT_PREVIEW_ORIGIN:'https://preview.example.co.uk'},'https://mail.example.co.uk','/tmp/mail')).toThrow(/different site/);
  });
  it.each(['0','1.5','NaN','9007199254740992'])('rejects invalid size budgets %s',value=>{
    expect(()=>loadDownloadConfig({...env,ATTACHMENT_STAGE_MAX_BYTES:value},'https://mail.example.co.uk','/tmp/mail')).toThrow();
  });
  it('rejects credential-bearing and non-origin endpoints',()=>{
    expect(()=>loadDownloadConfig({...env,DOWNLOAD_ORIGIN:'https://user:password@download.example.co.uk'},'https://mail.example.co.uk','/tmp/mail')).toThrow();
    expect(()=>loadDownloadConfig({...env,DOWNLOAD_ORIGIN:'https://download.example.co.uk/path'},'https://mail.example.co.uk','/tmp/mail')).toThrow();
  });
});
