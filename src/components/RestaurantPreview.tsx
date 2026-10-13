import { useState } from 'react';
import type { RestaurantInfo } from '../types';
import { Icon } from './Icon';
import './restaurant-preview.css';

export function RestaurantPreview({ restaurant }: { restaurant: RestaurantInfo }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const imageUrl = restaurant.imageUrl?.startsWith('https://') ? restaurant.imageUrl : undefined;
  return <section className="restaurant-preview" aria-label="已核验的餐厅详情">
    <div className="restaurant-preview-top">
      {imageUrl && !imageFailed ? <img className="restaurant-preview-image" src={imageUrl} alt={`${restaurant.restaurantName} 餐厅图片`} onError={() => setImageFailed(true)} /> : <span className="restaurant-preview-initial" aria-hidden="true">{restaurant.restaurantName.slice(0, 1)}</span>}
      <div className="restaurant-preview-heading"><span className="restaurant-verified"><Icon name="check" size={13} />已核验公开餐厅页</span><h3>{restaurant.restaurantName}</h3>{restaurant.category || restaurant.priceSummary ? <p>{[restaurant.category, restaurant.priceSummary].filter(Boolean).join(' · ')}</p> : null}{typeof restaurant.rating === 'number' || typeof restaurant.reviewCount === 'number' ? <p>{typeof restaurant.rating === 'number' ? `评分 ${restaurant.rating}` : ''}{typeof restaurant.reviewCount === 'number' ? ` · ${restaurant.reviewCount} 条评价` : ''}</p> : null}</div>
      <a className="icon-button restaurant-page-link" href={restaurant.restaurantUrl} target="_blank" rel="noreferrer" aria-label="查看已核验的官方餐厅页"><Icon name="external" size={17} /></a>
    </div>
    {restaurant.description ? <div><p className={`restaurant-description ${descriptionExpanded ? 'expanded' : 'collapsed'}`}>{restaurant.description}</p>{restaurant.description.length > 100 ? <button type="button" className="text-button restaurant-description-button" aria-expanded={descriptionExpanded} onClick={() => setDescriptionExpanded(value => !value)}>{descriptionExpanded ? '收起餐厅简介' : '展开餐厅简介'}</button> : null}</div> : null}
    {restaurant.address || restaurant.phone ? <div className="restaurant-facts">{restaurant.address ? <p><span>地址</span>{restaurant.address}</p> : null}{restaurant.phone ? <p><span>电话</span>{restaurant.phone}</p> : null}</div> : null}
    {restaurant.bookingNotes?.length ? <details className="restaurant-notes"><summary>查看餐厅预约说明 <span>{restaurant.bookingNotes.length} 条</span></summary><ul>{restaurant.bookingNotes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul></details> : null}
    <div className="restaurant-required"><Icon name="info" size={14} /><span>{restaurant.requiredFields?.length ? `公开页面提到的${restaurant.requiredFields.some(field => field.required) ? '必填' : '预约'}信息：${restaurant.requiredFields.map(field => `${field.label}${field.required ? '（必填）' : ''}`).join('、')}；继续预约时请核对实际表单。` : '登录／预约页中的必填项在继续预约时核对。'}</span></div>
  </section>;
}
