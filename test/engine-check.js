const fs=require('fs'); const MP=require('../mp.js');
(async()=>{
  const cat=MP.index(JSON.parse(fs.readFileSync(__dirname+'/../data/accessories.json','utf8')));
  const prices=await (await fetch('http://localhost:3512/api/prices')).json();
  console.log(`prices: ${prices.items} entries, sweep ${prices.sweepMs}ms, ${prices.pages}/${prices.expectedPages} pages, undecodable ${prices.undecodable}`);
  console.log(`recombobulator: ${prices.recombobulator ? Math.round(prices.recombobulator.buy).toLocaleString() : 'n/a'}`);

  const fmt=n=>n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'k':String(Math.round(n));

  // --- Fresh player, owns nothing
  const none={};
  const all=MP.offers(cat,none,prices,{contacts:0});
  console.log(`\noffers for a player who owns nothing: ${all.length}`);
  console.log('\nCHEAPEST POWER (coins per AP):');
  all.slice(0,12).forEach(o=>console.log(`  ${fmt(o.coinsPerMp).padStart(7)}/AP  ${fmt(o.cost).padStart(7)}  +${String(o.gain).padStart(2)}AP  ${o.name} (${o.rarity})${o.recomb?' [recomb]':''}  ${o.route}`));

  const maxT=MP.maxTierOffers(all);
  console.log(`\nMAX-TIER list: ${maxT.length} families purchasable`);
  const totalMax=maxT.reduce((n,o)=>n+o.cost,0), gainMax=maxT.reduce((n,o)=>n+o.gain,0);
  console.log(`  buy every family at its top purchasable tier: ${fmt(totalMax)} coins for +${gainMax} AP`);
  console.log('  most expensive:', maxT.slice().sort((a,b)=>b.cost-a.cost).slice(0,4).map(o=>`${o.name}=${fmt(o.cost)}`).join(', '));

  // --- Budget solver
  for(const b of [1e6,1e7,1e8,1e9]){
    const s=MP.solveBudget(all,b);
    const evalAfter=MP.multiplier(s.gain);
    console.log(`  budget ${fmt(b).padStart(5)}: ${String(s.picks.length).padStart(3)} buys, spend ${fmt(s.spend).padStart(6)}, +${String(s.gain).padStart(4)} AP (multiplier ${evalAfter.toFixed(1)})`);
  }

  // --- Family logic: own a low tier, verify only the gain counts
  const owned={ ZOMBIE_TALISMAN:{recomb:false} };
  const e1=MP.evaluate(cat,owned,{contacts:0});
  console.log(`\nowning ZOMBIE_TALISMAN only -> AP ${e1.total} (expect 3)`);
  const o1=MP.offers(cat,owned,prices,{contacts:0}).filter(o=>o.family===cat.byId.ZOMBIE_TALISMAN.family);
  o1.sort((a,b)=>b.toMp-a.toMp).slice(0,4).forEach(o=>console.log(`   -> ${o.name} ${o.rarity}${o.recomb?'*':''}: ${o.fromMp}->${o.toMp} (+${o.gain}) for ${fmt(o.cost)} via ${o.route}`));

  const owned2={ ZOMBIE_TALISMAN:{recomb:false}, ZOMBIE_ARTIFACT:{recomb:false} };
  console.log(`owning TALISMAN+ARTIFACT -> AP ${MP.evaluate(cat,owned2,{contacts:0}).total} (expect 8 = Rare artifact only, not 3+8)`);

  // --- Special cases
  const heg={ HEGEMONY_ARTIFACT:{recomb:false} };
  console.log(`Hegemony alone -> AP ${MP.evaluate(cat,heg,{contacts:0}).total} (expect 32 = 16 doubled)`);
  const hegR={ HEGEMONY_ARTIFACT:{recomb:true} };
  console.log(`Hegemony recombobulated -> AP ${MP.evaluate(cat,hegR,{contacts:0}).total} (expect 44 = 22 doubled)`);
  const abi={ ABICASE:{recomb:false} };
  console.log(`Abicase, 0 contacts -> ${MP.evaluate(cat,abi,{contacts:0}).total} (expect 8)`);
  console.log(`Abicase, 80 contacts -> ${MP.evaluate(cat,abi,{contacts:80}).total} (expect 48)`);
  const prism={ RIFT_PRISM:{recomb:false} };
  console.log(`Rift Prism -> ${MP.evaluate(cat,prism,{contacts:0}).total} (expect 11)`);
  const starstone={ CRUX_TALISMAN_7:{recomb:false} };
  console.log(`Celestial Starstone alone -> ${MP.evaluate(cat,starstone,{contacts:0}).total} (expect 0)`);
  const crux6={ CRUX_TALISMAN_6:{recomb:false}, CRUX_TALISMAN_7:{recomb:false} };
  console.log(`Crux 6 + Starstone -> ${MP.evaluate(cat,crux6,{contacts:0}).total} (expect 22, starstone must not win)`);

  // --- earnables
  const earn=MP.earnable(cat,none,prices,{contacts:0});
  console.log(`\nnot purchasable (must be earned): ${earn.length} families, ${earn.reduce((n,e)=>n+e.gain,0)} AP total`);
  earn.slice(0,6).forEach(e=>console.log(`   +${String(e.gain).padStart(2)}AP ${e.name}${e.rift?' [rift]':''}${e.soulbound?' [soulbound '+e.soulbound+']':''}`));
})();
