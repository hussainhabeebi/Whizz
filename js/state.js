const USERS_DEFAULT = {
  'admin@whizz.com':      { name: 'Whizz Admin',   role: 'Administrator', allowedBrands: [], allowedPlatforms: [] },
  'sales@whizz.com':      { name: 'Sales Team',    role: 'Sales',         allowedBrands: [], allowedPlatforms: ['Viral'] },
  'manager@whizz.com':    { name: 'Whizz Manager', role: 'Manager',       allowedBrands: [], allowedPlatforms: [] },
  'mohsin@whizz.com':     { name: 'Mohsin',        role: 'Sales',         allowedBrands: [], allowedPlatforms: ['Mohsin'] },
  'waqas@whizz.com':      { name: 'Waqas',         role: 'Sales',         allowedBrands: [], allowedPlatforms: ['Waqas'] },
  'hussain@whizzfze.com': { name: 'Hussain',       role: 'Administrator', allowedBrands: [], allowedPlatforms: [] }
};
let USERS = (()=>{ const raw=localStorage.getItem('whizz_users_v1'); if(raw){try{const p=JSON.parse(raw);Object.entries(p).forEach(([email,u])=>{if(!u.allowedBrands)u.allowedBrands=[];if(!u.allowedPlatforms){u.allowedPlatforms=USERS_DEFAULT[email]?.allowedPlatforms||[];}});return p;}catch(e){}} return JSON.parse(JSON.stringify(USERS_DEFAULT)); })();
function saveUsers(){ localStorage.setItem('whizz_users_v1', JSON.stringify(USERS)); }

let S = {
  page: 'dashboard', convStatus: 'open',
  groups: [], crossTabMatrix: [], templates: [], platforms: [], countries: [], brands: [],
  selectedGroups: [], selectedTemplate: null,
  activePlatform: 'ALL', activeCountry: 'ALL', activeBrand: 'ALL',
  stock: [], stockCrossTab: [], stockBrands: [], stockRegions: [], stockParentGroups: [],
  activeStockBrand: 'ALL', activeStockRegion: 'ALL', activeStockParentGroup: 'ALL', activeStockStatus: 'ALL',
  discoveredContacts: [], selectedDiscContacts: new Set(), discType: 'wholesaler',
  cache: {}, notifications: [], history: [],
  selectedConvId: null, liveSync: false, liveSyncTimer: null, convMessages: {}
};
