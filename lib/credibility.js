// How much weight a retrieved source deserves, in words a reader can check. Everything Infomedics
// retrieves comes from a short list of credible places (PubMed, MedlinePlus, the NHS website); this
// labels each item so the reader can see why it counts.

const ORGS = {
  medlineplus: { label: 'Government health agency', detail: 'US National Library of Medicine (MedlinePlus)' },
  nhs: { label: 'Government health service', detail: 'UK National Health Service (nhs.uk)' }
};

/**
 * @param {{kind: string, design?: string, journal?: string, indexed?: boolean}} evidence
 * @returns {{tier: 'agency'|'peer_reviewed'|'journal', label: string, detail: string}}
 */
export function credibilityOf(evidence) {
  if (ORGS[evidence.kind]) return { tier: 'agency', ...ORGS[evidence.kind] };
  const journal = evidence.journal ? evidence.journal : 'a journal';
  if (evidence.indexed) {
    return { tier: 'peer_reviewed', label: 'Peer-reviewed, MEDLINE-indexed', detail: `${evidence.design || 'Study'} in ${journal}. MEDLINE only indexes journals its NLM reviewers select.` };
  }
  return { tier: 'journal', label: 'Journal article, not MEDLINE-indexed', detail: `${evidence.design || 'Study'} in ${journal}. Listed in PubMed, but the journal is not in NLM's selected MEDLINE set, so weigh it more carefully.` };
}

export const SOURCE_NAMES = { pubmed: 'PubMed search', medlineplus: 'MedlinePlus search', nhs: 'NHS website search' };
