# HOME page big SELECT — SQL → Sequelize JOIN mapping (Beginner‑friendly)

This note explains only the big SELECT in the `get_page_content` stored procedure (HOME branch) and how the same joins are expressed with Sequelize includes. You’ll learn:
- For each SQL JOIN: what it does and the equivalent Sequelize include
- Why to use a parent include vs a nested include
- How the “sub‑join” block for promocodes was converted (2‑step approach)
- Why `PromotionXProduct` is included from `Brand` as a parent include even though the SQL shows it in a grouped JOIN

---

## 1) The big SQL JOIN (simplified)

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

Key idea: The result is “per brand.” Every INNER JOIN filters brands that don’t meet conditions.

In Sequelize, we model this as a root query on `Brand` with multiple `include` blocks, each `required: true` to act like an INNER JOIN.

---

## 2) Choosing the root in Sequelize

- SQL starts from `brand_categories` and joins to `brands`.
- In Sequelize we can choose any root that makes sense. Since the output is “one brand per row,” we choose `Brand.findAll(...)` and include the related models.

This is equivalent because INNER JOINs are symmetric for filtering: starting at `Brand` and requiring the other relations yields the same surviving rows.

---

## 3) Join‑by‑Join mapping

Below is the exact mapping used in your `pageContent.service.js` with the “why” next to each include.

### 3.1 brand_categories INNER JOIN categories
SQL intent: brand must belong to an active category via an active brand_category row.

Sequelize (nested include):
```js
{
  model: BrandCategory,            // Parent include: Brand → BrandCategory (direct association)
  where: { status: 'A' },          // WHERE brand_categories.status = 'A'
  required: true,                  // INNER JOIN (filter brands without an active brand_category)
  attributes: [],                  // don’t fetch extra columns
  include: [{
    model: Category,               // Nested include: BrandCategory → Category
    where: { status: 'A' },        // WHERE categories.status = 'A'
    required: true,                // INNER JOIN through the chain
    attributes: []
  }]
}
```
- Why parent include? Brand hasMany BrandCategory.
- Why nested include? Category is reached through BrandCategory, not directly from Brand.

### 3.2 products AS p (active, in stock, not expired)
SQL intent: brand must have at least one eligible product.

Sequelize (parent include):
```js
{
  model: Product,                  // Parent include: Brand → Product
  where: {
    status: 'A',
    available_qty: { [Op.gt]: 0 },
    expiry_date: { [Op.gte]: fn('CURDATE') }
  },
  required: true,                  // INNER JOIN (filter brands without eligible product)
  attributes: ['price']            // used later to build products_denominations
}
```
- Parent include because Brand hasMany Product (direct FK brand_id).
- Conditions belong in the include’s `where` so they apply to the join.

### 3.3 promotion_x_products + promotions (and later promocodes)
SQL intent: brand must participate in an active discount promotion via promotion_x_products and promotions.

Sequelize mapping (parent + nested include):
```js
{
  model: PromotionXProduct,        // Parent include: Brand → PromotionXProduct
  where: { status: 'A', promotion_type: 'D' },
  required: true,                  // INNER JOIN
  attributes: ['short_desc'],
  include: [{
    model: Promotion,              // Nested include: PromotionXProduct → Promotion
    where: { status: 'A', offer_type: 'DIS' },
    required: true,
    attributes: ['id', ['value', 'discount_value'], 'offer_type']
  }]
}
```
- Why parent include from Brand? Because the ON clause ties `promotion_x_products.brand_id = brands.id`. That is a direct association in the data model, so it’s natural to express as Brand → PromotionXProduct.
- Why nested include for Promotion? Because Promotion is related to PromotionXProduct by `promotion_id` (child of a child relative to Brand).

What about the product check inside the grouped block? The SQL also joins `products` again inside the parentheses to ensure each promotion_x_products row references an active, in‑stock, not‑expired product.****** You already ensure product eligibility with the separate parent include on `Product`. If you want to enforce it specifically for the promotion’s product as well, you can add a second nested include under `PromotionXProduct` to `Product` with the same `where` (this is optional if the first product include is sufficient for business needs).

### 3.4 offers o (for ordering)
SQL intent: join `offers` and order by `o.order_number`.

Sequelize (optional, if you need the same ordering):
```js
{
  model: Offer,                    // Parent include: Brand → Offer (Brand hasMany Offer)
  as: 'Offers',
  where: { status: 'A' },
  required: true,
  attributes: ['order_number']
}
// And order:
order: [[{ model: Offer, as: 'Offers' }, 'order_number', 'ASC']]
```
If you don’t need this exact ordering, you can omit the join. The current service omits it.

---

## 4) “Sub‑join” to promocodes — how we converted it

In SQL, `promocodes` is part of the big parenthesized join and filters by multiple conditions (status, date window, usage rules). If you include `Promocode` directly in Sequelize as nested includes, you’ll often get multiple rows per Brand (cartesian expansion) and more data than needed.

A clean pattern is the 2‑step approach used in your service:
1) Join up to `Promotion` to get a list of `promotion.id` values for eligible brands.
2) Make one batch query:
```js
const rows = await Promocode.findAll({
  where: {
    promotion_id: promotionIds,
    status: 'VALID',
    start_date: { [Op.lte]: fn('CURDATE') },
    expiry_date: { [Op.gte]: fn('CURDATE') },
    [Op.or]: [ { usage_type: 'M' }, { [Op.and]: [{ usage_type: 'S' }, { blasted: 'Y' }] } ]
  },
  attributes: ['promotion_id', 'promocode']
});
```
3) Build a map `{ promotion_id → promocode }` and attach one promocode per promotion in memory.

Why this is good:
- Prevents row explosion from deep eager loads
- Lets you choose “one promocode per promotion” deterministically
- Keeps the main query’s shape simple and fast

If you really want to eager‑load it in one shot, you can nest `Promocode` under `Promotion` with `required: true` and matching `where`, but be mindful of duplicates.

---

## 5) Parent include vs Nested include — rules of thumb

- Use a parent include when there is a direct association from the root model (Brand → Product, Brand → PromotionXProduct, Brand → Offer, Brand → BrandCategory).
- Use a nested include when you need to follow the chain through a parent include (BrandCategory → Category, PromotionXProduct → Promotion, Promotion → Promocode).
- Put join filters in the include where they conceptually belong.
- `required: true` means INNER JOIN (filter out brands with no matching rows). `required: false` is a LEFT JOIN (keep brands even if no matches).

Cheat sheet:
```js
// Parent include (Brand → Product)
include: [{ model: Product, required: true, where: { status: 'A' } }]

// Nested include (Brand → BrandCategory → Category)
include: [{
  model: BrandCategory, required: true, where: { status: 'A' },
  include: [{ model: Category, required: true, where: { status: 'A' } }]
}]
```

---

## 6) FAQ — Why is PromotionXProduct a parent include from Brand?

In the SQL, `promotion_x_products` appears inside a grouped JOIN, so it “looks nested,” but the ON condition says:
```
promotion_x_products.brand_id = brands.id AND promotion_x_products.status = 'A' AND promotion_x_products.promotion_type = 'D'
```
That means `promotion_x_products` is directly related to `brands` by `brand_id`. In Sequelize, includes reflect data model associations, not visual nesting in SQL. So the natural translation is a parent include from `Brand`:
```js
{
  model: PromotionXProduct,        // direct Brand → PromotionXProduct association via brand_id
  where: { status: 'A', promotion_type: 'D' },
  required: true,
  include: [{ model: Promotion, where: { status: 'A', offer_type: 'DIS' }, required: true }]
}
```
The inner parentheses in SQL are just syntactic grouping of multiple joins; they don’t imply that `promotion_x_products` is a child of a child. The real relationship is defined by the foreign keys used in the ON clause.

---

## 7) Optional strict parity tweaks

- Add Offer join and `order` to match `ORDER BY o.order_number` exactly.
- If you must ensure the promotion’s own product passes the stock/expiry checks (not just any brand product), add a nested include under `PromotionXProduct`:
```js
{
  model: PromotionXProduct,
  required: true,
  include: [{
    model: Product,
    required: true,
    where: { status: 'A', available_qty: { [Op.gt]: 0 }, expiry_date: { [Op.gte]: fn('CURDATE') } },
    attributes: []
  }]
}
```

---

## 8) Minimal working skeleton (HOME)

```js
const brands = await Brand.findAll({
  where: { status: 'A' },
  attributes: ['id', ['name', 'brand_name'], 'slug'],
  include: [
    { model: BrandCategory, where: { status: 'A' }, required: true, attributes: [], include: [
      { model: Category, where: { status: 'A' }, required: true, attributes: [] }
    ]},
    { model: Product, where: { status: 'A', available_qty: { [Op.gt]: 0 }, expiry_date: { [Op.gte]: fn('CURDATE') } }, required: true, attributes: ['price'] },
    { model: PromotionXProduct, where: { status: 'A', promotion_type: 'D' }, required: true, attributes: ['short_desc'], include: [
      { model: Promotion, where: { status: 'A', offer_type: 'DIS' }, required: true, attributes: ['id', ['value','discount_value'], 'offer_type'] }
    ]}
    // Optionally: { model: Offer, as: 'Offers', where: { status: 'A' }, required: true, attributes: ['order_number'] }
  ],
  // Optionally: order: [[{ model: Offer, as: 'Offers' }, 'order_number', 'ASC']]
});
```

This matches the big SQL JOIN’s intent using parent and nested includes appropriately.
