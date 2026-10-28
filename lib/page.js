// Judge the *page* a claim came from: who runs it, whether it names an author and date, whether it
// cites research, whether it is selling something. These are rule-based and shown as signals, not a score.

import { classifyDomain, hostOf, isResearchHost } from './sources.js';

const COMMERCE_RES = [
  [/\badd to (?:cart|basket)\b/i, 'add-to-cart buttons'],
  [/\bbuy (?:now|today|one)\b|\border now\b|\bshop now\b/i, 'buy/order buttons'],
  [/\b\d{1,2}% off\b|\bfree shipping\b|\blimited[- ]time (?:offer|deal)\b|\bsubscribe (?:&|and) save\b/i, 'discount or shipping offers'],
  [/\bmoney[- ]back guarantee\b/i, 'money-back guarantee'],
  [/\baffiliate\b|\bcommission\b/i, 'affiliate links'],
  [/\bsponsored\b|\badvertorial\b|\bpaid partnership\b/i, 'sponsored content']
];

/**
 * @returns {{url, finalUrl, host, title, siteName, author, published, modified, wordCount,
 *            domain: {tier, name?}, researchLinks: number, researchSamples: string[],
 *            hasReferences: boolean, commerce: string[], signals: {id,label,status,detail}[]}}
 */
export function assessPage({ url, finalUrl, extracted }) {
  const host = hostOf(finalUrl || url);
  const domain = classifyDomain(host);

  const researchSamples = [];
  const citedLinks = [];
  let researchLinks = 0;
  for (const link of extracted.links) {
    const linkHost = hostOf(link);
    if (linkHost && linkHost !== host && isResearchHost(linkHost)) {
      researchLinks++;
      if (researchSamples.length < 3 && !researchSamples.includes(link)) researchSamples.push(link);
      if (citedLinks.length < 6 && !citedLinks.some((c) => c.url === link)) {
        const kind = classifyDomain(linkHost);
        citedLinks.push({ url: link, host: linkHost, label: kind.tier === 'trusted' ? kind.name : 'Research journal, database or government site' });
      }
    }
  }

  const commerce = COMMERCE_RES.filter(([re]) => re.test(extracted.text)).map(([, label]) => label);

  const signals = [];
  if (domain.tier === 'trusted') {
    signals.push({ id: 'source', label: 'Source', status: 'good', detail: `${domain.name} is a well-known health organization.` });
  } else if (domain.tier === 'institutional') {
    signals.push({ id: 'source', label: 'Source', status: 'good', detail: 'A government or university website. Usually reliable, but still check the claim itself.' });
  } else {
    signals.push({ id: 'source', label: 'Source', status: 'info', detail: `We have no reputation information for ${host}. Judge it by the signals below.` });
  }

  signals.push(extracted.author
    ? { id: 'author', label: 'Author', status: 'good', detail: `Names an author: ${extracted.author}.` }
    : { id: 'author', label: 'Author', status: 'warn', detail: 'No author could be found on the page.' });

  const date = extracted.modified || extracted.published;
  if (date) {
    const ageYears = (Date.now() - Date.parse(date)) / (365.25 * 24 * 3600 * 1000);
    signals.push(ageYears > 5
      ? { id: 'date', label: 'Date', status: 'warn', detail: `Last dated ${date}. Health advice more than five years old may be out of date.` }
      : { id: 'date', label: 'Date', status: 'good', detail: `Dated ${date}.` });
  } else {
    signals.push({ id: 'date', label: 'Date', status: 'warn', detail: 'No publication or review date could be found.' });
  }

  if (researchLinks >= 2 || extracted.hasReferences) {
    signals.push({ id: 'citations', label: 'Citations', status: 'good', detail: researchLinks
      ? `Links to ${researchLinks} research or health-agency source${researchLinks === 1 ? '' : 's'}${extracted.hasReferences ? ' and has a references section' : ''}.`
      : 'Has a references section.' });
  } else if (researchLinks === 1) {
    signals.push({ id: 'citations', label: 'Citations', status: 'info', detail: 'Links to one research or health-agency source.' });
  } else {
    signals.push({ id: 'citations', label: 'Citations', status: 'warn', detail: 'Does not link to any studies or health agencies.' });
  }

  signals.push(commerce.length
    ? { id: 'commerce', label: 'Selling something', status: 'warn', detail: `Signs of selling or sponsorship: ${commerce.join(', ')}. This is not proof of bias, but it is worth knowing.` }
    : { id: 'commerce', label: 'Selling something', status: 'good', detail: 'No obvious selling or sponsorship signals found.' });

  return {
    url,
    finalUrl: finalUrl || url,
    host,
    title: extracted.title,
    siteName: extracted.siteName,
    author: extracted.author,
    published: extracted.published,
    modified: extracted.modified,
    wordCount: extracted.wordCount,
    domain,
    researchLinks,
    researchSamples,
    citedLinks,
    hasReferences: extracted.hasReferences,
    commerce,
    signals
  };
}
