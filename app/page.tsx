"use client";
import { FormEvent, useState } from "react";
type Result = { name: string; size: number };
const DEV = process.env.NODE_ENV !== "production";
function log(level: "debug"|"info"|"warn"|"error", code: string, message: string, details?: unknown) {
  if (!DEV && level !== "error") return;
  const fn = console[level] as (...args: unknown[]) => void;
  fn.call(console, `[SiteArchiver][${code}]`, message, details ?? "");
}
export default function Home() {
 const [url,setUrl]=useState(""); const [busy,setBusy]=useState(false); const [status,setStatus]=useState(""); const [files,setFiles]=useState<Result[]>([]); const [error,setError]=useState("");
 async function submit(e:FormEvent) {
  e.preventDefault(); setBusy(true); setError(""); setStatus("Connecting to the website and collecting public files…"); setFiles([]);
  const started=Date.now(); log("info","UI-1000","Archive request started",{url,at:new Date().toISOString()});
  try {
   let parsed:URL; try { parsed=new URL(url.includes("://")?url:`https://${url}`); } catch { log("warn","UI-1001","Client-side URL validation failed",{url}); throw new Error("Enter a valid URL, such as https://example.com."); }
   if (!["http:","https:"].includes(parsed.protocol)) { log("warn","UI-1002","Unsupported URL protocol",{protocol:parsed.protocol}); throw new Error("Only HTTP and HTTPS websites are supported."); }
   log("debug","UI-1003","Sending archive API request",{host:parsed.host,protocol:parsed.protocol});
   const res=await fetch("/api/archive",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:parsed.toString()})});
   log("debug","HTTP-2000","Archive API responded",{status:res.status,statusText:res.statusText,elapsedMs:Date.now()-started,contentType:res.headers.get("content-type")});
   if(!res.ok) {
    const body=await res.json().catch(()=>({})); const code=typeof body.code==="string"?body.code:`HTTP-${res.status}`;
    log("error",code,"Archive request rejected",{status:res.status,message:body.error||"No error message"});
    throw new Error(body.error||`Request failed (${res.status}). Check the browser console for the diagnostic code.`);
   }
   const blob=await res.blob(); const disposition=res.headers.get("Content-Disposition")||""; const match=disposition.match(/filename="([^"]+)"/); const filename=match?.[1]||"website-archive.zip";
   log("info","ZIP-3000","ZIP received",{filename,bytes:blob.size,elapsedMs:Date.now()-started});
   if(blob.size===0) { log("error","ZIP-3001","Server returned an empty ZIP"); throw new Error("The archive was empty. Try another URL."); }
   const objectUrl=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=objectUrl; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
   const count=res.headers.get("X-Archive-File-Count"); const report=res.headers.get("X-Archive-Manifest");
   if(report) { try { setFiles(JSON.parse(decodeURIComponent(report))); } catch(err) { log("warn","ZIP-3002","Could not parse archive manifest header",err); } }
   setStatus(`ZIP created and download started.${count?` ${count} files included.`:""}`); log("info","UI-1004","Download triggered successfully",{fileCount:count,elapsedMs:Date.now()-started});
  } catch(err) { const message=err instanceof Error?err.message:"Unexpected client error"; setError(message); setStatus(""); log("error","UI-1099","Archive workflow failed",{message,elapsedMs:Date.now()-started,stack:err instanceof Error?err.stack:undefined}); }
  finally { setBusy(false); }
 }
 return <main className="shell"><nav className="topbar"><div className="brandMark">SA</div><span>Site Archiver</span><span className="pill">PUBLIC FILES ONLY</span></nav>
 <section className="hero"><div className="eyebrow"><span className="dot"/> WEBSITE EXPORT TOOL</div><h1>Save a website.<br/><span>Keep the files.</span></h1><p className="subhead">Enter a public website URL to collect its reachable pages and same-site assets, then package them into a ZIP.</p>
 <form onSubmit={submit} className="panel"><label htmlFor="url">Website URL</label><div className="urlrow"><span className="urlicon">↗</span><input id="url" type="url" required placeholder="https://example.com" value={url} onChange={e=>setUrl(e.target.value)}/><button type="submit" disabled={busy}>{busy?"Working…":"Fetch & ZIP"} <span>→</span></button></div><div className="panelFoot"><span><i className="check">✓</i>No installation required</span><span>Up to 50 files · 15 MB total</span></div></form>
 {status&&<div className="status"><span className={busy?"spinner":"success"}>{busy?"":"✓"}</span>{status}</div>}{error&&<div className="error" role="alert">{error}</div>}</section>
 <section className="details"><div className="detailCard"><div className="number">01</div><h3>Fetch public resources</h3><p>Collects the starting page, same-host linked pages, stylesheets, scripts, images, fonts, and other linked assets.</p></div><div className="detailCard"><div className="number">02</div><h3>Package into a ZIP</h3><p>Stores files in a simple folder structure based on their URLs, with a manifest of what was collected.</p></div><div className="detailCard"><div className="number">03</div><h3>Download and inspect</h3><p>Unzip it locally and open the included HTML. Dynamic sites may need their original backend to work.</p></div></section>
 <aside className="notice"><strong>Important limitations</strong><p>This downloads only resources the public site exposes. It cannot retrieve server source code, databases, private files, or authenticated content. Pages that require JavaScript rendering may not archive completely. Use it only for sites you own or have permission to archive.</p></aside>
 {files.length>0&&<section className="fileList"><h2>Included in the last archive</h2>{files.map(f=><div className="file" key={f.name}><span>{f.name}</span><small>{(f.size/1024).toFixed(1)} KB</small></div>)}</section>}
 <footer>Site Archiver <span>·</span> Archives public content only</footer></main>;
}