import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('enables the download button only when the link is not empty', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('app-link-input input') as HTMLInputElement;
    const button = el.querySelector('app-link-input button') as HTMLButtonElement;

    expect(button.disabled).toBe(true);

    input.value = 'https://youtu.be/abc';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(button.disabled).toBe(false);

    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
  });
});
