import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/auth";
import { UserRole } from "@prisma/client";

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
    { name: "Kitchen", slug: "kitchen", description: "Everything for your kitchen" },
    { name: "Clothing", slug: "clothing", description: "Trendy clothes for everyone" },
    { name: "Artificial Nails", slug: "artificial-nails", description: "Stylish press-on nails" },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: {},
      create: category,
    });
  }

  const kitchen = await prisma.category.findUnique({ where: { slug: "kitchen" } });
  const clothing = await prisma.category.findUnique({ where: { slug: "clothing" } });
  const nails = await prisma.category.findUnique({ where: { slug: "artificial-nails" } });

  const products = [
    {
      name: "Non-Stick Frying Pan",
      slug: "non-stick-frying-pan",
      description: "Durable non-stick frying pan for everyday cooking.",
      price: 24.99,
      comparePrice: 34.99,
      stock: 50,
      images: ["https://placehold.co/600x400?text=Frying+Pan"],
      categoryId: kitchen!.id,
    },
    {
      name: "Stainless Steel Knife Set",
      slug: "stainless-steel-knife-set",
      description: "Professional 5-piece knife set for your kitchen.",
      price: 39.99,
      stock: 30,
      images: ["https://placehold.co/600x400?text=Knife+Set"],
      categoryId: kitchen!.id,
    },
    {
      name: "Cotton Summer T-Shirt",
      slug: "cotton-summer-t-shirt",
      description: "Soft and breathable cotton t-shirt.",
      price: 19.99,
      stock: 100,
      images: ["https://placehold.co/600x400?text=T-Shirt"],
      categoryId: clothing!.id,
    },
    {
      name: "Denim Jacket",
      slug: "denim-jacket",
      description: "Classic denim jacket for all seasons.",
      price: 59.99,
      comparePrice: 79.99,
      stock: 40,
      images: ["https://placehold.co/600x400?text=Denim+Jacket"],
      categoryId: clothing!.id,
    },
    {
      name: "French Tip Press-On Nails",
      slug: "french-tip-press-on-nails",
      description: "Elegant french tip press-on nails, 24 pieces.",
      price: 12.99,
      stock: 80,
      images: ["https://placehold.co/600x400?text=French+Nails"],
      categoryId: nails!.id,
    },
    {
      name: "Matte Black Nails",
      slug: "matte-black-nails",
      description: "Stylish matte black press-on nails.",
      price: 14.99,
      stock: 60,
      images: ["https://placehold.co/600x400?text=Matte+Nails"],
      categoryId: nails!.id,
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { slug: product.slug },
      update: {},
      create: product,
    });
  }

  console.log("Seeded database:", { admin: admin.email, categories: categories.length, products: products.length });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
