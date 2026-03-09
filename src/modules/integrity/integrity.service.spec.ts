import { Test, TestingModule } from '@nestjs/testing';
import { IntegrityService } from './integrity.service';

describe('IntegrityService', () => {
  let service: IntegrityService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntegrityService],
    }).compile();

    service = module.get<IntegrityService>(IntegrityService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
