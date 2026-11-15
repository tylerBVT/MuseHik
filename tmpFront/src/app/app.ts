import { Component } from '@angular/core';
import { LinkInput } from './link-input/link-input';

@Component({
  imports: [LinkInput],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {}
