// Users live in D1 (shared across every admin/device) instead of localStorage, since
// whizz-add-user/whizz-delete-user also sync this list to the Cloudflare Access policy
// that gates who can reach the app. This is just an in-memory cache of the last fetch.
let USERS = {};
async function loadUsers(){
  const d = await apiW('whizz-get-users');
  USERS = {};
  (d.users||[]).forEach(u=>{ USERS[u.email] = u; });
}

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
