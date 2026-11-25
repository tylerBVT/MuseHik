import { backStep } from './back-button';

describe('backStep (the phone\'s Back button)', () => {
  it('closes an open menu or dialog first, on any page', () => {
    expect(backStep({ dialogOpen: true, page: 'cloud' })).toBe('close-dialog');
    expect(backStep({ dialogOpen: true, page: 'home' })).toBe('close-dialog');
  });

  it('goes to the previous page when not on the home page', () => {
    expect(backStep({ dialogOpen: false, page: 'cloud' })).toBe('back');
    expect(backStep({ dialogOpen: false, page: 'playlist' })).toBe('back');
  });

  it('on the home page, puts the app in the background (the music keeps playing) instead of closing it', () => {
    expect(backStep({ dialogOpen: false, page: 'home' })).toBe('minimize');
  });
});
