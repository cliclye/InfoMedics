// Which sites we treat as reputable, and links to send people to for their own look.

// Registrable domain -> display name. Hand-picked, deliberately short.
const TRUSTED = {
  'who.int': 'World Health Organization',
  'cdc.gov': 'CDC',
  'nih.gov': 'National Institutes of Health',
  'nlm.nih.gov': 'National Library of Medicine',
  'medlineplus.gov': 'MedlinePlus',
  'fda.gov': 'US FDA',
  'nhs.uk': 'NHS (UK)',
  'nice.org.uk': 'NICE (UK)',
  'mayoclinic.org': 'Mayo Clinic',
  'clevelandclinic.org': 'Cleveland Clinic',
  'hopkinsmedicine.org': 'Johns Hopkins Medicine',
  'health.harvard.edu': 'Harvard Health',
  'cochrane.org': 'Cochrane',
  'heart.org': 'American Heart Association',
  'cancer.org': 'American Cancer Society',
  'diabetes.org': 'American Diabetes Association',
  'healthychildren.org': 'American Academy of Pediatrics'
};

// Hosts whose links count as "cites research" when a page links to them.
const RESEARCH_HOSTS = [
  'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'doi.org', 'cochranelibrary.com', 'cochrane.org',
  'nejm.org', 'thelancet.com', 'bmj.com', 'jamanetwork.com', 'nature.com', 'science.org',
  'sciencedirect.com', 'springer.com', 'link.springer.com', 'wiley.com', 'onlinelibrary.wiley.com',
  'plos.org', 'journals.plos.org', 'frontiersin.org', 'mdpi.com', 'oup.com', 'academic.oup.com',
  'cell.com', 'tandfonline.com', 'sagepub.com', 'biomedcentral.com', 'who.int', 'cdc.gov', 'nih.gov',
  'nhs.uk', 'fda.gov', 'clinicaltrials.gov', 'europepmc.org'
];

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function endsWithDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

// -> { tier: 'trusted' | 'institutional' | 'unknown', name?: string }
export function classifyDomain(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  for (const [domain, name] of Object.entries(TRUSTED)) {
    if (endsWithDomain(host, domain)) return { tier: 'trusted', name };
  }
  if (/\.(gov|edu)$/.test(host) || /\.(gov|ac)\.[a-z]{2}$/.test(host) || /\.(gov|edu)\.[a-z]{2}$/.test(host)) {
    return { tier: 'institutional' };
  }
  return { tier: 'unknown' };
}

export function isResearchHost(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  return RESEARCH_HOSTS.some((h) => endsWithDomain(host, h)) || /\.(gov|edu)$/.test(host);
}

// Search pages on reputable sites, so people can look for themselves.
export function searchLinks(query) {
  const q = encodeURIComponent(query);
  return [
    { name: 'PubMed', url: `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`, note: 'Research papers' },
    { name: 'MedlinePlus', url: `https://medlineplus.gov/search.html?query=${q}`, note: 'Plain-language health topics' },
    { name: 'NHS', url: `https://www.nhs.uk/search/results?q=${q}`, note: 'UK National Health Service' },
    { name: 'CDC', url: `https://search.cdc.gov/search/?query=${q}`, note: 'US public health agency' }
  ];
}

export const ORG_HOMEPAGES = [
  { name: 'World Health Organization', url: 'https://www.who.int' },
  { name: 'CDC', url: 'https://www.cdc.gov' },
  { name: 'NIH', url: 'https://www.nih.gov' },
  { name: 'Mayo Clinic', url: 'https://www.mayoclinic.org' },
  { name: 'NHS', url: 'https://www.nhs.uk' }
];
