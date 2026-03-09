import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuthService } from '../modules/auth/auth.service';
import { CustomersService } from '../modules/customers/customers.service';
import { ProductsService } from '../modules/products/products.service';
import { Logger } from '@nestjs/common';

async function seed() {
  const logger = new Logger('Seeder');
  const app = await NestFactory.createApplicationContext(AppModule);

  const authService = app.get(AuthService);
  const customersService = app.get(CustomersService);
  const productsService = app.get(ProductsService);

  try {
    logger.log('Starting seeding...');

    // 1. Create a shop owner
    const owner = await authService.register({
      email: 'owner@shop.com',
      password: 'password123',
      name: 'Chidi Okafor',
      shopName: 'Chidi Provisions Shop',
    });
    const userId = (owner.user as any).id;
    logger.log(`Created owner: ${owner.user.email}`);

    // 2. Create some customers
    const customer1 = await customersService.create(
      {
        name: 'Babatunde Adekunle',
        phone: '+2348012345678',
      },
      userId,
    );

    const customer2 = await customersService.create(
      {
        name: 'Ibrahim Musa',
        phone: '+2348098765432',
      },
      userId,
    );

    logger.log(`Created customers: ${customer1.name}, ${customer2.name}`);

    // 3. Create some products
    const product1 = await productsService.create(
      {
        name: 'Indomie Onion Flavor',
        unitPrice: 150,
        bulkPrice: 4500,
      },
      userId,
    );

    const product2 = await productsService.create(
      {
        name: 'Peak Milk Sachet',
        unitPrice: 100,
        bulkPrice: 2800,
      },
      userId,
    );

    const product3 = await productsService.create(
      {
        name: 'Gala Sausage Roll',
        unitPrice: 50,
        bulkPrice: 1200,
      },
      userId,
    );

    logger.log(
      `Created products: ${product1.name}, ${product2.name}, ${product3.name}`,
    );

    logger.log('Seeding completed successfully!');
  } catch (error) {
    logger.error('Seeding failed:', error.message);
  } finally {
    await app.close();
  }
}

seed();
