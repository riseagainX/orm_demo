
const {
  PageContent,
  Brand,
  Category,
  Product,
  PromotionXProduct,
  Promotion,
  Promocode,
  BrandCategory,
} = require('../models');
const { Op, fn } = require('sequelize');
const logger = require('../utils/logger.util');


// HELPER FUNCTION FOR SIMPLE PAGES (OFFER, GIFTING, ETC.)

const getSimplePageContent = async (title) => {
  logger.info('getSimplePageContent started', { title });
  
  const pageContent = await PageContent.findOne({
    where: { title, status: 'A' },

    attributes: [
      'title', 'banner', 'mob_banner', 'carausel1', 'carausel2', 'carausel3',
      'seo_title', 'seo_keyword', 'seo_description', 'description',
    ],
  });
  
  logger.success('getSimplePageContent completed', { title, found: !!pageContent });
  return { pageContent };
};


// LOGIC FOR THE COMPLEX 'HOME' PAGE USING SEQUELIZE ORM

const getHomePageContent = async () => {
  logger.info('getHomePageContent started');
  
  // === Part 1: Fetch the static page content for 'HOME' ===
  const pageContent = await PageContent.findOne({
    where: { title: 'HOME', status: 'A' },
    attributes: [
      'title', 'banner', 'mob_banner', 'carausel1', 'carausel2', 'carausel3',
      'seo_title', 'seo_keyword', 'seo_description', 'description',
    ],
  });

  // === Part 2: OPTIMIZED - Single query with nested promocode include (NO N+1) ===
  const brandsData = await Brand.findAll({
    where: { status: 'A' },
    attributes: [
      'id',
      ['name', 'brand_name'],
      'description',
      'slug',
      'new_arrival',
      'updated',
      'seo_title',
      'seo_keyword',
      'seo_description'
    ],
    include: [
      // Must have active category via brand_categories
      {
        model: BrandCategory,
        where: { status: 'A' },
        required: true,
        attributes: [],
        include: [
          {
            model: Category,
            where: { status: 'A' },
            required: true,
            attributes: []
          }
        ]
      },
      // Must have active product with stock and not expired
      {
        model: Product,
        where: {
          status: 'A',
          available_qty: { [Op.gt]: 0 },
          expiry_date: { [Op.gte]: fn('CURDATE') }
        },
        required: true,
        attributes: ['price']
      },
      // Must have active discount promotion with nested promocode (NO N+1!)
      {
        model: PromotionXProduct,
        where: { status: 'A', promotion_type: 'D' },
        required: true,
        attributes: ['short_desc'],
        include: [
          {
            model: Promotion,
            where: { status: 'A', offer_type: 'DIS' },
            required: true,
            attributes: ['id', ['value', 'discount_value'], 'offer_type'],
            include: [
              {
                // Nested promocode include - eliminates separate batch query
                model: Promocode,
                where: {
                  status: 'VALID',
                  start_date: { [Op.lte]: fn('CURDATE') },
                  expiry_date: { [Op.gte]: fn('CURDATE') },
                  [Op.or]: [
                    { usage_type: 'M' },
                    { [Op.and]: [{ usage_type: 'S' }, { blasted: 'Y' }] }
                  ]
                },
                required: true, // Only include promotions that have valid promocodes
                attributes: ['promocode'],
                limit: 1 // Only one promocode per promotion
              }
            ]
          }
        ]
      }
    ]
    // Note: No GROUP BY needed - Sequelize automatically groups results by primary key
  });

  if (brandsData.length === 0) {
    logger.warn('getHomePageContent no brands found');
    return { pageContent, brandsData: [] };
  }

  logger.info('getHomePageContent brands fetched', { count: brandsData.length });

  // === Part 3: Build final response with products_denominations ===
  const result = [];
  for (const brand of brandsData) {
    const brandObj = brand.get({ plain: true });
    const pxp = brandObj.PromotionXProducts?.[0];
    const promotion = pxp?.Promotion;
    
    if (!promotion) {
      logger.warn('Brand missing promotion, skipping', { brandId: brandObj.id });
      continue;
    }

    // Optimized: Calculate unique denominations using Set
    const uniquePrices = [...new Set((brandObj.Products || []).map(p => p.price))];
    const products_denominations = uniquePrices.length > 0 ? uniquePrices.join(',') : null;

    result.push({
      id: brandObj.id,
      brand_name: brandObj.brand_name,
      description: brandObj.description,
      slug: brandObj.slug,
      new_arrival: brandObj.new_arrival,
      updated: brandObj.updated,
      seo_title: brandObj.seo_title,
      seo_keyword: brandObj.seo_keyword,
      seo_description: brandObj.seo_description,
      products_denominations,
      discount_value: promotion.discount_value,
      offer_type: promotion.offer_type,
      promocode: promotion.Promocodes?.[0]?.promocode || null, // Direct access, no map needed
      short_desc: pxp.short_desc
    });
  }

  logger.success('getHomePageContent completed', { brandCount: result.length });
  return { pageContent, brandsData: result };
};


// MAIN EXPORTED FUNCTION

const getPageContent = async (givenTitle) => {
  logger.info('getPageContent called', { title: givenTitle });
  
  try {
    // Use a switch statement, the direct JavaScript equivalent of SQL's IF/ELSEIF.
    switch (givenTitle.toUpperCase()) {
      case 'HOME':
        return getHomePageContent();

      case 'OFFER':
      case 'GIFTING':
      case 'DISCOUNT':
      case 'PROMOCODE':
        return getSimplePageContent(givenTitle);

      default:
        // Throw an error for invalid input, which can be caught by the controller.
        logger.error('Invalid page title provided', { title: givenTitle });
        throw new Error(`Invalid page title provided: ${givenTitle}`);
    }
  } catch (error) {
    logger.error('getPageContent failed', { title: givenTitle, error: error.message });
    throw error;
  }
};

module.exports = { getPageContent };