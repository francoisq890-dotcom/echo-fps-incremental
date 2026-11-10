import './style.css';
import { Game } from './game';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const game = new Game(canvas);

// Accès console / captures headless (scripts/screenshots.mjs).
(window as unknown as { __echo: Game }).__echo = game;
