'use strict';
// Run in a public distribution repository. Source releases are read
// anonymously; the target repository's own GitHub Actions token publishes.
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const configs=Object.freeze({
 extension:{source:'aidilazharo/aiatech-assist',target:'aidilazharo/extension',checksum:'vsix.sha256',title:'ATGV'},
 library:{source:'aidilazharo/tech-stacks-skills',target:'aidilazharo/library',checksum:'library-source.sha256',title:'SDLC Library'}
});
function versionFor(tag,kind){
 const re=kind==='extension'?/^v(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+))?$/:/^v(\d+)\.(\d+)\.(\d+)(?:-source-build\.(\d+))?$/;
 const match=re.exec(String(tag||''));return match?{version:match.slice(1,4).join('.'),numbers:match.slice(1).map(n=>Number(n||0))}:null;
}
function latestRelease(releases,kind){
 if(!Array.isArray(releases)||!configs[kind])throw Error('Invalid public source releases.');
 const rows=releases.map(row=>({row,parsed:versionFor(row?.tag_name,kind)})).filter(x=>x.parsed&&!x.row.draft);
 rows.sort((a,b)=>{for(let i=0;i<4;i++)if(a.parsed.numbers[i]!==b.parsed.numbers[i])return b.parsed.numbers[i]-a.parsed.numbers[i];return (Date.parse(b.row.published_at)||0)-(Date.parse(a.row.published_at)||0);});
 return rows[0]||null;
}
function assetUrl(repository,tag,name){return `https://github.com/${repository}/releases/download/${tag}/${name}`;}
function selectAssets(selected,kind){
 const cfg=configs[kind],{row,parsed}=selected;
 const filename=kind==='extension'?`atgv-aiatech-assist-${parsed.version}.vsix`:`tech-stacks-skills-${parsed.version}-source.zip`;
 if(!/^[a-f0-9]{40}$/.test(String(row.target_commitish||'')))throw Error('The source release is not pinned to a commit.');
 const chosen=[filename,cfg.checksum].map(name=>{
  const asset=(row.assets||[]).find(x=>x.name===name);
  if(!asset||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>80*1024*1024||asset.browser_download_url!==assetUrl(cfg.source,row.tag_name,name))throw Error('Latest source release is missing a trusted '+name+'.');
  return asset;
 });
 return {filename,chosen};
}
async function fetchBytes(url,{allow404=false,maxBytes=80*1024*1024}={}){
 const response=await fetch(url,{headers:{'User-Agent':'ATGV-public-release-mirror','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(60000)});
 if(response.status===404&&allow404)return null;
 if(!response.ok)throw Error('Public GitHub request failed: HTTP '+response.status);
 const length=Number(response.headers.get('content-length')||0);
 if(length>maxBytes)throw Error('Release download exceeds size limit.');
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>maxBytes)throw Error('Release download exceeds size limit.');
 return bytes;
}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function verifyChecksum(bytes,checksum,filename){
 const expected=checksum.toString('utf8').split(/\r?\n/).map(line=>/^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line.trim())).find(row=>row&&row[2]===filename);
 if(!expected||expected[1]!==sha(bytes))throw Error('Source release SHA-256 verification failed.');
}
async function mirror({kind,target=process.env.GITHUB_REPOSITORY,fetcher=fetchBytes,runner=exec}={}){
 const cfg=configs[kind];
 if(!cfg||target!==cfg.target)throw Error('Unexpected release mirror repository.');
 const json=await fetcher(`https://api.github.com/repos/${cfg.source}/releases?per_page=100`,{maxBytes:4*1024*1024});
 const selected=latestRelease(JSON.parse(json.toString('utf8')),kind);
 if(!selected)return {status:'no-source-release'};
 const {row,parsed}=selected,{filename,chosen}=selectAssets(selected,kind);
 const [artifact,checksum]=await Promise.all(chosen.map(asset=>fetcher(asset.browser_download_url,{maxBytes:asset.size})));
 if(artifact.length!==chosen[0].size||checksum.length!==chosen[1].size)throw Error('Source asset size differs from the release metadata.');
 verifyChecksum(artifact,checksum,filename);
 const marker=`ATGV source: https://github.com/${cfg.source}/commit/${row.target_commitish}`;
 const existingBytes=await fetcher(`https://api.github.com/repos/${target}/releases/tags/${row.tag_name}`,{allow404:true,maxBytes:1024*1024});
 const existing=existingBytes?JSON.parse(existingBytes.toString('utf8')):null;
 if(existing&&!String(existing.body||'').includes(marker))throw Error('An existing target release has a different source identity; it was not replaced.');
 const files=[[filename,artifact],[cfg.checksum,checksum]],temp=await fs.mkdtemp(path.join(os.tmpdir(),'atgv-release-mirror-'));
 try{
  for(const [name,bytes] of files)await fs.writeFile(path.join(temp,name),bytes,{flag:'wx'});
  if(existing){
   for(const [name,bytes] of files){
    const asset=(existing.assets||[]).find(a=>a.name===name);
    if(asset){
     if(asset.browser_download_url!==assetUrl(target,row.tag_name,name))throw Error('Unexpected existing public release asset URL.');
     const actual=await fetcher(asset.browser_download_url,{maxBytes:80*1024*1024});
     if(sha(actual)!==sha(bytes))throw Error('Existing target release differs from the verified source.');
    }else await runner('gh',['release','upload',row.tag_name,path.join(temp,name),'--repo',target]);
   }
   return {status:'already-published',tag:row.tag_name};
  }
  const notes=`${cfg.title} v${parsed.version}. Verified against the source release SHA-256.\n\n${marker}\nSource release: https://github.com/${cfg.source}/releases/tag/${row.tag_name}`;
  const classification=row.prerelease?['--prerelease','--latest=false']:['--latest'];
  await runner('gh',['release','create',row.tag_name,...files.map(([name])=>path.join(temp,name)),'--repo',target,'--target','main','--title',`${cfg.title} v${parsed.version}`,'--notes',notes,...classification]);
  return {status:'published',tag:row.tag_name};
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(require.main===module)mirror({kind:process.env.ATGV_RELEASE_KIND}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={configs,versionFor,latestRelease,selectAssets,assetUrl,verifyChecksum,mirror};
