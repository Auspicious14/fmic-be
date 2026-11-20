import { soundsAlike } from './customer-resolver.service';

describe('soundsAlike (asks "Did you mean…?", never auto-picks)', () => {
  it.each([
    ['Trayo', 'Motunrayo'], // real misheard name from a test on 20 Nov
    ['Motun', 'Motunrayo'],
    ['Gani', 'Ganiyu'],
    ['Kamao', 'Kamau'],
    ['Mọ́túnráyọ̀', 'Motunrayo Adeyemi'],
    ['Mama Tunde', 'Mama Tunde Okafor'],
  ])('%s ~ %s', (heard, known) => {
    expect(soundsAlike(heard, known)).toBe(true);
  });

  it.each([
    ['Tunde', 'Kunle'],
    ['Bisi', 'Sola'],
    ['Ade', 'Adebayo'], // too short to judge
    ['Mama Tunde', 'Mama Bisi'], // shared title is not a match
    ['Baba Sola', 'Baba Gani'],
  ])('%s is not %s', (heard, known) => {
    expect(soundsAlike(heard, known)).toBe(false);
  });
});
