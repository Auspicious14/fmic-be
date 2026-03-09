import { Test, TestingModule } from '@nestjs/testing';
import { IntegrityController } from './integrity.controller';

describe('IntegrityController', () => {
  let controller: IntegrityController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [IntegrityController],
    }).compile();

    controller = module.get<IntegrityController>(IntegrityController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
