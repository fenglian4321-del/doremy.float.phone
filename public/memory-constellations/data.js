// Float adapter for MemoryConstellations v5. No network, credentials or persistence.
// Math/color helpers: Copyright (c) 2026 Clara Shafiq & Draco Malfoy. MIT; see ./LICENSE.
export const GALAXIES = [
 {id:"恒常",hue:35,azimuth:-90,desc:"核心记忆"},
 {id:"日常",hue:275,azimuth:30,desc:"日常片段"},
 {id:"其他",hue:190,azimuth:150,desc:"其他记忆"}
];
export const GALAXY_BY_ID=Object.fromEntries(GALAXIES.map(g=>[g.id,g]));
export function strHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── 星系色相家族：基准 hue + 名字 hash 偏移 ±25° ──
export function colorFor(galaxyId, name) {
    const g = GALAXY_BY_ID[galaxyId] || GALAXIES[0];
    const h = strHash(name);
    const hue = (g.hue + (h % 51) - 25 + 360) % 360;
    const sat = 62 + ((h >>> 8) % 18);          // 62-79%
    const lit = 62 + ((h >>> 16) % 14);         // 62-75%
    return { hue, sat, lit, css: `hsl(${hue},${sat}%,${lit}%)` };
}

export function hslToRgbStr(hue, sat, lit) {
    const s = sat / 100, l = lit / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return `${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)}`;
}


export const universe={constellations:[],core:[],bridges:[],galaxyBridges:[],totalFragments:0,loaded:false};
export function consOfGalaxy(id){return universe.constellations.filter(c=>c.galaxyLabel===id);}
export function conById(id){return universe.constellations.find(c=>c.id===id)||null;}
// Presentation groups reflect only existing types and the first tag/domain; no inferred emotions or semantic links.
export function setEntries(entries){
 const groups=new Map();
 for(const entry of entries.slice(0,200)){
  const galaxyLabel=entry.type==="permanent"?"恒常":entry.type==="dynamic"?"日常":"其他";
  const label=(entry.tags?.[0]||entry.domains?.[0]||"未分类").slice(0,80);
  const key=JSON.stringify([galaxyLabel,label]);
  if(!groups.has(key)){
   const col=colorFor(galaxyLabel,label);
   groups.set(key,{id:key,label,galaxyLabel,color:col.css,rgb:hslToRgbStr(col.hue,col.sat,col.lit),stars:[]});
  }
  // Equal brightness: no fabricated importance, confidence, decay or emotional scores.
  groups.get(key).stars.push({id:entry.id,title:entry.name,mag:3,conf:1});
 }
 universe.constellations=Array.from(groups.values()).map(c=>({...c,fragment_count:c.stars.length,stars:c.stars.map(s=>({...s,conId:c.id,conLabel:c.label}))}));
 universe.totalFragments=entries.slice(0,200).length;universe.loaded=true;
}

