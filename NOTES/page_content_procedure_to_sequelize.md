# Page Content: Stored Procedure → Sequelize Mapping (Beginner Friendly)

This guide explains how your MySQL stored procedure `get_page_content` maps to the current Sequelize implementation in `services/pageContent.service.js`, and teaches you how to translate JOINs into Sequelize `include` at parent vs nested levels.

- Stored procedure: see your attachment (get_page_content)
- Sequelize service: `services/pageContent.service.js`

## Quick answer: Is it equivalent?

- For simple pages (`OFFER`, `GIFTING`, `DISCOUNT`, `PROMOCODE`): YES. The service uses a direct `PageContent.findOne({ where: { title, status: 'A' } })`, which matches each branch in the procedure.
- For `HOME` page: functionally equivalent for the core logic (active brands with active categories, active products in stock and not expired, active discount promotions, and a valid promocode per promotion). The service also computes `products_denominations` (comma‑separated prices) which is an extra useful field not selected in the procedure.
- Differences you should know:
  1) The stored procedure joins the `offers` table and orders by `o.order_number`. The current Sequelize code does not include `Offer` yet and does not order by it. If that order matters, see the "Add Offers join and ordering" section below.
  2) The procedure joins `promocodes` inside the same SQL block. The Sequelize code does this in two steps: it first loads `Promotion` via joins, then batch-fetches `Promocode` rows by `promotion_id` and maps them. This is equivalent, more efficient than N-per-brand lookups, and easier to maintain.

If you want exact parity with the `offers` ORDER BY, I can update the service to add the Offers join and ordering.

---

## How each SQL JOIN maps to Sequelize include

Below is the big JOIN block for `HOME` in your procedure (simplified and annotated):

```sql
FROM brand_categories
INNER JOIN categories ON categories.id = brand_categories.category_id AND categories.status = 'A'
INNER JOIN brands ON brands.id = brand_categories.brand_id
INNER JOIN offers o ON o.brand_id = brands.id AND o.status = 'A'
INNER JOIN products AS p ON (
  p.brand_id = brands.id AND p.status = 'A' AND p.available_qty > 0 AND p.expiry_date >= CURDATE()
)
INNER JOIN (
  promotion_x_products
  INNER JOIN products ON (
    products.id = promotion_x_products.product_id AND
    products.status = 'A' AND products.available_qty > 0 AND products.expiry_date >= CURDATE()
  )
  INNER JOIN promotions ON (
    promotions.id = promotion_x_products.promotion_id AND
    promotions.status = 'A' AND promotions.offer_type IN ('DIS')
  )
  INNER JOIN promocodes ON (
    promocodes.promotion_id = promotions.id AND
    promocodes.status = 'VALID' AND
    promocodes.start_date <= CURDATE() AND
    promocodes.expiry_date >= CURDATE() AND (
      promocodes.usage_type = 'M' OR (promocodes.usage_type = 'S' AND promocodes.blasted = 'Y')
    )
  )
) ON (
  promotion_x_products.status = 'A' AND
  promotion_x_products.brand_id = brands.id AND
  promotion_x_products.promotion_type = 'D'
)
WHERE brands.status = 'A' AND brand_categories.status = 'A'
GROUP BY brands.id
ORDER BY o.order_number;
```

### Parent includes vs nested includes
- Parent include = direct association from the root model you query (here: `Brand.findAll({... include: [...]})`).
- Nested include = association of an included model (e.g., `BrandCategory` → `Category`, or `PromotionXProduct` → `Promotion`).
- INNER JOIN in Sequelize = `required: true`.
- LEFT JOIN in Sequelize = `required: false` (default if omitted).

### Sequelize mapping from your service (HOME page)

Root query:
```js
const brandsData = await Brand.findAll({
  where: { status: 'A' },               // WHERE brands.status = 'A'
  attributes: ['id', ['name', 'brand_name'], 'description', 'slug', 'new_arrival', 'updated', 'seo_title', 'seo_keyword', 'seo_description'],
  include: [
    // 1) brand_categories INNER JOIN ... WHERE brand_categories.status = 'A'
    {
      model: BrandCategory,
      where: { status: 'A' },         // WHERE brand_categories.status = 'A'
      required: true,                  // INNER JOIN
      attributes: [],                  // don't select extra columns
      include: [
        // 1a) categories INNER JOIN ... WHERE categories.status = 'A'
        {
          model: Category,
          where: { status: 'A' },     // WHERE categories.status = 'A'
          required: true,
          attributes: []
        }
      ]
    },

    // 2) products INNER JOIN ... status=A, stock>0, not expired
    {
      model: Product,
      where: {
        status: 'A',
        available_qty: { [Op.gt]: 0 },
        expiry_date: { [Op.gte]: fn('CURDATE') }
      },
      required: true,                  // INNER JOIN
      attributes: ['price']            // used to build products_denominations
    },

    // 3) promotion_x_products INNER JOIN ...
    {
      model: PromotionXProduct,
      where: { status: 'A', promotion_type: 'D' },
      required: true,
      attributes: ['short_desc'],
      include: [
        // 3a) promotions INNER JOIN ... status=A and offer_type='DIS'
        {
          model: Promotion,
          where: { status: 'A', offer_type: 'DIS' },
          required: true,
          attributes: ['id', ['value', 'discount_value'], 'offer_type']
        }
      ]
    }
  ]
});
```

### Where is the `promocodes` JOIN?
- In SQL, it’s part of the big JOIN block.
- In Sequelize, the code does it in 2 steps (this is a clean and efficient pattern):
  1) Load `Promotion` IDs from the join above.
  2) Batch query `Promocode.findAll({ where: { promotion_id: [ids], status: 'VALID', date window, usage_type ... } })`.
  3) Build a map `{ promotion_id → promocode }` and attach `promocode` to each brand in-memory.

This pattern avoids an explosion of rows and makes it easy to pick a single promocode per promotion.

### Where is the `offers` JOIN and ORDER BY?
- Not present in the current service. The procedure orders by `o.order_number` (from `offers`).
- If you rely on this order in the UI, add the `Offer` include and order by it (see next section for code).

---

## Add Offers join and ordering (exact parity with the procedure)

If you want 100% parity with the stored procedure’s `ORDER BY o.order_number`, add:

```js
const { Offer } = require('../models');

const brandsData = await Brand.findAll({
  where: { status: 'A' },
  include: [
    // ... BrandCategory→Category include
    // ... Product include
    // ... PromotionXProduct→Promotion include

    // Offer INNER JOIN o ON o.brand_id = brands.id AND o.status='A'
    {
      model: Offer,
      as: 'Offers',                    // use the alias defined in your associations
      where: { status: 'A' },
      required: true,
      attributes: ['order_number']
    }
  ],
  // ORDER BY o.order_number
  order: [[{ model: Offer, as: 'Offers' }, 'order_number', 'ASC']]
});
```

Notes:
- Ensure your model associations define `Brand.hasMany(Offer, { as: 'Offers', foreignKey: 'brand_id' })` (or the correct relation) and the inverse.
- If you only need the ordering, you can also join `Offer` with `required: false` and still order by it, but the procedure uses INNER JOIN.

---

## Parent vs nested include: when to use which?

- Use a parent include when the association is directly from the root model.
  - Example: `Brand → Product`, `Brand → PromotionXProduct`, `Brand → Offer`.
- Use a nested include when you need to chain a join through another include.
  - Example: `Brand → BrandCategory (parent)` then `BrandCategory → Category (nested)`.
- Put the `where:` for the join conditions inside the specific include whose rows you want to filter.
- Use `required: true` (INNER JOIN) when the presence of the child row is mandatory. Use `required: false` (LEFT JOIN) when optional.

Cheat sheet:
```js
// Parent include (Brand → Product)
include: [{ model: Product, required: true, where: { status: 'A' } }]

// Nested include (Brand → BrandCategory → Category)
include: [{
  model: BrandCategory, required: true, where: { status: 'A' },
  include: [{ model: Category, required: true, where: { status: 'A' } ]
}]
```

---

## GROUP BY and duplicates

The procedure uses `GROUP BY brands.id`. In Sequelize:
- You usually get a single `Brand` instance with arrays of associated records (e.g., `Products`) thanks to eager loading.
- If you do see duplicates (rare, model-dependent), you can add:
  - `distinct: true` on the root query, or
  - `group: ['Brand.id']` if you’re also using aggregates.

Example:
```js
const brandsData = await Brand.findAll({
  distinct: true,
  include: [/* ... */]
});
```

---

## How the simple branches map (`OFFER`, `GIFTING`, `DISCOUNT`, `PROMOCODE`)

Stored procedure (example):
```sql
SELECT content2 as offer_content, banner as offer_banner, mob_banner as mobile_banner,
       seo_title, seo_keyword, seo_description
FROM page_content
WHERE title = given_title AND status = 'A';
```

Sequelize:
```js
const pageContent = await PageContent.findOne({
  where: { title, status: 'A' },
  attributes: ['title','banner','mob_banner','carausel1','carausel2','carausel3','seo_title','seo_keyword','seo_description','description']
});
```
You can alias response fields at controller/mapper level if you want exact key names (e.g., `offer_content`).

---

## End‑to‑end flow recap

1) For HOME:
   - Parent includes ensure only brands that satisfy all INNER JOINs survive
   - Nested includes express `BrandCategory → Category` and `PromotionXProduct → Promotion`
   - A batch query fetches `Promocode` rows and maps one code per promotion
   - Final JSON includes brand fields, discount value, offer type, promocode, short_desc, and `products_denominations`

2) For other pages:
   - A single `PageContent.findOne` implements each IF branch from the procedure.

---

## Checklist: convert any JOIN from SQL → Sequelize

- Identify the root table (the table in the FROM of your outer query).
- For each INNER JOIN:
  - Find the association direction (root → child or child of child?)
  - Add an `include` for that model
  - Put join filters in that include’s `where:`
  - Set `required: true` for INNER JOIN, `false` for LEFT JOIN
- For chained joins, use nested `include` blocks
- For complex sub-joins (like `promocodes`), consider a separate batch query
- Add `attributes: []` on includes you don’t need fields from (performance)
- Add `order` clauses if you need deterministic ordering (including via associated models)
- Use `distinct: true` or `group` when using aggregates or to remove duplicates

---

## Want exact ORDER BY like the procedure?

Your current service doesn’t join `Offer` or order by `o.order_number`. If you’d like, I can add:
- `Offer` include with `required: true, where: { status: 'A' }`
- `order: [[{ model: Offer, as: 'Offers' }, 'order_number', 'ASC']]`

This will match the stored procedure’s ordering precisely.

---

Updated: October 31, 2025