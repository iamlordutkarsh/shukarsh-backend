import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/auth";
import { UserRole } from "@prisma/client";

const IMAGE_PARAMS = "auto=format&fit=crop&w=1200&q=80";

function image(id: string) {
  return `https://images.unsplash.com/${id}?${IMAGE_PARAMS}`;
}

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: "admin@shukarsh.com" },
    update: {},
    create: {
      email: "admin@shukarsh.com",
      password: hashPassword("admin123"),
      firstName: "Admin",
      lastName: "Shukarsh",
      role: UserRole.ADMIN,
    },
  });

  const categories = [
    { name: "Kitchen", slug: "kitchen", description: "Soft, sturdy pieces for the heart of your home" },
    { name: "Clothing", slug: "clothing", description: "Everyday layers in easy, cosy shapes" },
    { name: "Artificial Nails", slug: "artificial-nails", description: "Salon-ready press-on sets in minutes" },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name, description: category.description },
      create: category,
    });
  }

  const kitchen = await prisma.category.findUnique({ where: { slug: "kitchen" } });
  const clothing = await prisma.category.findUnique({ where: { slug: "clothing" } });
  const nails = await prisma.category.findUnique({ where: { slug: "artificial-nails" } });

  const products = [
    {
      name: "Everyday Non-Stick Frying Pan",
      slug: "non-stick-frying-pan",
      description:
        "A featherweight 24 cm pan with a ceramic non-stick coat, stay-cool handle and an even base that works on gas and induction. Eggs slide, pancakes flip, washing up takes seconds.",
      price: 1299,
      comparePrice: 1799,
      stock: 50,
      images: [image("photo-1581622558638-818128465982"), image("photo-1622839065814-02ddfdb8996c")],
      categoryId: kitchen!.id,
    },
    {
      name: "Stainless Steel Knife Set",
      slug: "stainless-steel-knife-set",
      description:
        "Five forged knives, a chef, santoku, utility, paring and bread, in a compact block. High-carbon steel holds its edge and the handles sit balanced in small hands.",
      price: 1899,
      comparePrice: 2499,
      stock: 30,
      images: [image("photo-1609467334293-030ac6448fd8"), image("photo-1636412191749-53d84f5f3eb0")],
      categoryId: kitchen!.id,
    },
    {
      name: "Cloud Glaze Mug Set",
      slug: "cloud-glaze-mug-set",
      description:
        "Two 330 ml stoneware mugs finished in a soft reactive glaze, so every pair comes out a little different. Chunky handle, microwave and dishwasher friendly.",
      price: 899,
      stock: 64,
      images: [image("photo-1555447014-7ead71574544"), image("photo-1515401857507-c897a8f64e42")],
      categoryId: kitchen!.id,
    },
    {
      name: "Pantry Glass Jar Trio",
      slug: "pantry-glass-jar-trio",
      description:
        "Three airtight borosilicate jars (500 ml, 750 ml, 1 L) with bamboo lids and silicone seals. Keeps dal, pasta and biscuits crisp, and looks tidy on an open shelf.",
      price: 1149,
      comparePrice: 1499,
      stock: 45,
      images: [image("photo-1565620731358-e8c038abc8d1"), image("photo-1559837957-bab8edc53c85")],
      categoryId: kitchen!.id,
    },
    {
      name: "Pastel Dinner Plate Set",
      slug: "pastel-dinner-plate-set",
      description:
        "Four 26 cm stoneware plates in lilac, blush, mint and cream. Chip-resistant rims, stackable, and pretty enough to serve straight from the kitchen.",
      price: 1499,
      stock: 28,
      images: [image("photo-1577576223142-c60979ba2740"), image("photo-1624819107687-15524ecf555a")],
      categoryId: kitchen!.id,
    },
    {
      name: "Cotton Summer T-Shirt",
      slug: "cotton-summer-t-shirt",
      description:
        "Breathable 180 GSM combed cotton with a relaxed drop shoulder and a neckband that keeps its shape after wash number fifty. Pre-shrunk, so your size stays your size.",
      price: 799,
      comparePrice: 1099,
      stock: 120,
      images: [image("photo-1716951923523-0c76b14d4852"), image("photo-1759572095329-1dcf9522762b")],
      categoryId: clothing!.id,
    },
    {
      name: "Classic Denim Jacket",
      slug: "denim-jacket",
      description:
        "Mid-wash rigid denim that softens into your shape, with a boxy crop, antique brass buttons and roomy chest pockets. Layers over everything from a slip dress to a hoodie.",
      price: 2499,
      comparePrice: 3299,
      stock: 40,
      images: [image("photo-1543076447-215ad9ba6923"), image("photo-1602515931029-16b4a8ff505a")],
      categoryId: clothing!.id,
    },
    {
      name: "Soft Knit Pullover",
      slug: "soft-knit-pullover",
      description:
        "A brushed acrylic-cotton blend knit that feels like a hug and does not itch. Ribbed cuffs, a gently oversized body and no pilling after a cold wash.",
      price: 1899,
      stock: 36,
      images: [image("photo-1621198059871-0d5f9b449233"), image("photo-1556095667-9760aa7f4885")],
      categoryId: clothing!.id,
    },
    {
      name: "Breezy Summer Dress",
      slug: "breezy-summer-dress",
      description:
        "Airy rayon with a smocked back, adjustable straps and side pockets. Falls just below the knee and packs down small for weekends away.",
      price: 1699,
      comparePrice: 2199,
      stock: 42,
      images: [image("photo-1520026582657-4daf5bb60adb"), image("photo-1582738509941-360b28c941ea")],
      categoryId: clothing!.id,
    },
    {
      name: "French Tip Press-On Nails",
      slug: "french-tip-press-on-nails",
      description:
        "Twenty-four hand-finished tips in ten sizes with a glossy almond shape. Comes with adhesive tabs, glue, a mini file and a cuticle stick. Lasts one to two weeks.",
      price: 499,
      comparePrice: 699,
      stock: 90,
      images: [image("photo-1630843599725-32ead7671867"), image("photo-1610992015732-2449b76344bc")],
      categoryId: nails!.id,
    },
    {
      name: "Matte Midnight Press-On Nails",
      slug: "matte-black-nails",
      description:
        "A velvet matte black set in a short coffin shape, sealed with a scratch-resistant top coat. Twenty-four tips, ten sizes, full prep kit included.",
      price: 549,
      stock: 70,
      images: [image("photo-1587729927069-ef3b7a5ab9b4"), image("photo-1604654894610-df63bc536371")],
      categoryId: nails!.id,
    },
    {
      name: "Sugar Heart Press-On Nails",
      slug: "sugar-heart-press-on-nails",
      description:
        "Milky pink tips with tiny hand-painted hearts and a pearl accent nail. Reusable if you lift them gently with cuticle oil, so one box lasts several wears.",
      price: 599,
      comparePrice: 799,
      stock: 55,
      images: [image("photo-1754799670410-b282791342c3"), image("photo-1754799670312-8e7da8e40ad7")],
      categoryId: nails!.id,
    },
    {
      name: "Nail Prep and Care Kit",
      slug: "nail-prep-and-care-kit",
      description:
        "Everything to make press-ons last: pH prep wipes, brush-on glue, 100 adhesive tabs, a dual-grit file, buffer and cuticle oil pen in a zip pouch.",
      price: 899,
      stock: 60,
      images: [image("photo-1696342003838-4a8f9f36588c"), image("photo-1696341980130-4bdff3322802")],
      categoryId: nails!.id,
    },
  ];

  for (const product of products) {
    const { slug, ...rest } = product;
    await prisma.product.upsert({
      where: { slug },
      update: rest,
      create: { slug, ...rest },
    });
  }

  console.log("Seeded database:", {
    admin: admin.email,
    categories: categories.length,
    products: products.length,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
