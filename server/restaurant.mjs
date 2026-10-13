import { HttpError, restaurantUrl } from './domain.mjs';

function restaurantIdentity(url) {
  try { return new URL(restaurantUrl(url)).pathname.split('/').filter(Boolean).at(-1); } catch { return null; }
}
const shortText = (value, max = 500) => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
const GENERIC = /^(?:Catchtable(?: Global)?|캐치테이블|餐厅|Restaurants?|菜单|Menu|Reviews?|评论|评价|登录(?:或注册)?|Sign in|Login|My Dining|我的用餐|预订|Reservation)$/i;

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flattenJsonLd(value['@graph']), ...flattenJsonLd(value.mainEntity)];
}
function verifiedHttps(value) {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
function addressText(value) {
  if (typeof value === 'string') return shortText(value);
  if (!value || typeof value !== 'object') return undefined;
  return shortText(['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'].map((key) => {
    const item = value[key]; return typeof item === 'string' ? item : key === 'addressCountry' && item?.name ? item.name : '';
  }).filter(Boolean).join(', '));
}

export function parseRestaurantSnapshot(snapshot, requestedUrl, now = Date.now()) {
  const inputUrl = restaurantUrl(requestedUrl);
  const id = restaurantIdentity(inputUrl);
  if (!snapshot || restaurantIdentity(snapshot.url) !== id) throw new HttpError(502, '餐厅页面没有返回匹配的官方餐厅，仍可手动填写名称。');
  if (snapshot.canonicalUrl && restaurantIdentity(snapshot.canonicalUrl) !== id) throw new HttpError(502, '官方页面规范地址与输入餐厅不一致，未自动填入名称。');
  const canonical = snapshot.canonicalUrl ? restaurantUrl(snapshot.canonicalUrl) : restaurantUrl(snapshot.url);
  const nodes = (snapshot.jsonLd || []).flatMap((value) => {
    try { return flattenJsonLd(typeof value === 'string' ? JSON.parse(value) : value); } catch { return []; }
  });
  const heading = (snapshot.headings || []).find(({ level, text }) => [1, 2].includes(level) && shortText(text, 100) && !GENERIC.test(text.trim()));
  const entity = nodes.find((node) => [node['@type']].flat().some((type) => typeof type === 'string' && /^(?:Restaurant|FoodEstablishment)$/.test(type))
    && (node.url ? restaurantIdentity(node.url) === id : heading && shortText(node.name,100)?.toLowerCase() === shortText(heading.text,100)?.toLowerCase()));
  const restaurantName = shortText(entity?.name, 100) || shortText(heading?.text, 100);
  if (!restaurantName || GENERIC.test(restaurantName)) throw new HttpError(502, '公开页面没有可确认的餐厅名称。可保留链接并手动填写名称。');
  const fields = snapshot.fields || {};
  const info = { restaurantUrl: canonical, restaurantName,
    bookingNotes: ['当前仅核验公开餐厅页面；预约表单的必填项尚无法确认，请进入官方预约页后核对。'],
    requiredFields: [], defaults: { partySize: 2, timeStart: '18:00', timeEnd: '20:00' },
    verifiedAt: new Date(now).toISOString(), source: 'catchtable_public' };
  const optional = {
    description: shortText(entity?.description || snapshot.restaurantDescription || (snapshot.description?.includes(restaurantName) ? snapshot.description : undefined), 1000),
    address: addressText(entity?.address) || shortText(fields.address),
    category: shortText(Array.isArray(entity?.servesCuisine) ? entity.servesCuisine.join(' · ') : entity?.servesCuisine || fields.category, 200),
    priceSummary: shortText(entity?.priceRange || fields.priceSummary, 200),
    phone: shortText(entity?.telephone || fields.phone, 100),
    imageUrl: verifiedHttps(typeof entity?.image === 'string' ? entity.image : Array.isArray(entity?.image) ? entity.image[0]?.url || entity.image[0] : entity?.image?.url)
      || (snapshot.imageRestaurantSpecific===true || verifiedHttps(snapshot.imageUrl)?.includes(id) ? verifiedHttps(snapshot.imageUrl) : undefined),
  };
  const information=snapshot.information;
  if(information) {
    let sameInfo=false;
    try {const target=new URL(canonical);const infoUrl=new URL(information.url);sameInfo=infoUrl.protocol==='https:' && ['catchtable.net','www.catchtable.net'].includes(infoUrl.hostname) && !infoUrl.port && !infoUrl.username && !infoUrl.password
      && infoUrl.pathname.replace(/\/$/,'')===`${target.pathname.replace(/\/$/,'')}/info` && information.restaurantName?.trim().toLowerCase()===restaurantName.toLowerCase();}catch{}
    if(sameInfo) {
      optional.address=shortText(information.address) || optional.address;
      optional.phone=shortText(information.phone,100) || optional.phone;
      optional.description=shortText(information.description,1500) || optional.description;
      const notes=(information.bookingNotes || []).map(note=>shortText(note,1500)).filter(Boolean);
      info.bookingNotes.unshift(...notes);
    }
  }
  const rating = Number(entity?.aggregateRating?.ratingValue ?? fields.rating);
  const reviewCount = Number(entity?.aggregateRating?.reviewCount ?? fields.reviewCount);
  if ((entity?.aggregateRating?.ratingValue ?? fields.rating) !== undefined && Number.isFinite(rating) && rating >= 0 && rating <= 5) optional.rating = rating;
  if ((entity?.aggregateRating?.reviewCount ?? fields.reviewCount) !== undefined && Number.isInteger(reviewCount) && reviewCount >= 0) optional.reviewCount = reviewCount;
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) info[key] = value;
  return info;
}

export async function readRestaurantSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility !== 'hidden');
    const value = (selector) => {
      const element = [...document.querySelectorAll(selector)].find(visible);
      return element?.getAttribute('content') || element?.innerText?.trim() || undefined;
    };
    const phone = [...document.querySelectorAll('a[href^="tel:"]')].find(visible)?.getAttribute('href')?.replace(/^tel:/, '');
    const heading=[...document.querySelectorAll('h1,h2')].find(visible);
    const main=heading?.closest('section');
    const paragraphs=main?[...main.querySelectorAll('p')].filter(visible):[];
    const breadcrumb=paragraphs.find(element=>/^[^•]+\s*•\s*[^•]+$/.test(element.innerText.trim()));
    const description=paragraphs.filter(element=>element!==breadcrumb && element.innerText.trim()).map(element=>element.innerText.trim()).join('\n\n');
    const ratings=main?[...main.querySelectorAll('span')].filter(visible).filter(element=>/^(?:[0-4](?:\.\d+)?|5(?:\.0+)?)$/.test(element.innerText.trim()) && /^\([\d,]+\)$/.test(element.nextElementSibling?.innerText?.trim() || '')):[];
    const rating=ratings.length===1?ratings[0]:null;
    const prices=main?[...main.querySelectorAll('span')].filter(visible).map(element=>element.innerText.trim()).filter(text=>/^(?:₩|KRW|\$|USD)\s*[\d,]+(?:\s*[~–-]\s*(?:₩|KRW|\$|USD)?\s*[\d,]+)?$/.test(text)):[];
    const informationLink=[...document.querySelectorAll('a[href]')].find(element=>visible(element) && /^(?:信息|Information|Info|정보)$/i.test(element.innerText.trim()))?.href;
    return {
      url: location.href, canonicalUrl: document.querySelector('link[rel="canonical"]')?.href,
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2')].filter(visible).map((element) => ({ level: Number(element.tagName.slice(1)), text: element.innerText.trim() })),
      description: document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content,
      restaurantDescription: value('[itemprop="description"], [data-testid="restaurant-description"]') || description || undefined,
      informationLink,
      imageUrl: document.querySelector('meta[property="og:image"]')?.content,
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent),
      fields: { address: value('[itemprop="address"]'), category: value('[itemprop="servesCuisine"]') || breadcrumb?.innerText.split('•')[1]?.trim(), priceSummary: value('[itemprop="priceRange"]') || (prices.length===1?prices[0]:undefined),
        rating: value('[itemprop="ratingValue"]') || rating?.innerText.trim(), reviewCount: value('[itemprop="reviewCount"]') || rating?.nextElementSibling?.innerText.trim().replace(/[(),]/g,''), phone },
    };
  });
}

export async function readRestaurantInformationSnapshot(page) {
  return page.evaluate(()=>{
    const visible=element=>Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility!=='hidden');
    const headings=[...document.querySelectorAll('h1,h2')].filter(visible);
    const sections=[...document.querySelectorAll('section')].filter(visible);
    const sectionFor=pattern=>sections.find(section=>{const heading=section.querySelector('h3');return heading && pattern.test(heading.innerText.trim());});
    const about=sectionFor(/^(?:关于本店|关于我们|About(?: us| the restaurant)?|매장 소개)$/i);
    const locationSection=sectionFor(/^(?:位置|地址|Location|Address|위치)$/i);
    const details=sectionFor(/^(?:详细信息|详情|Details|Additional information|상세 정보)$/i);
    const following=pattern=>{
      const labels=details?[...details.querySelectorAll('p')].filter(visible).filter(element=>pattern.test(element.innerText.trim())):[];
      const next=labels.length===1?labels[0].nextElementSibling:null;
      return next?.tagName==='P' && visible(next)?next.innerText.trim():undefined;
    };
    const phone=following(/^(?:电话|Phone|Telephone|전화)$/i);
    const notes=following(/^(?:注意事项|预约须知|Reservation (?:notes|policy)|Notice|Important information|유의사항|주의사항)$/i);
    return {url:location.href,restaurantName:headings[0]?.innerText.trim(),
      address:locationSection?[...locationSection.querySelectorAll(':scope > p')].find(visible)?.innerText.trim():undefined,
      description:about?[...about.querySelectorAll('p')].filter(visible).map(element=>element.innerText.trim()).join('\n\n'):undefined,
      phone:phone && /^\+?\d[\d ()-]+$/.test(phone)?phone:undefined,bookingNotes:notes?[notes]:[]};
  });
}
