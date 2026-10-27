import { env } from 'node:process';

// terminal styling is decided when the renderer first loads, so contract tests
// exercise unstyled text regardless of the runner's own output colors
env.FORCE_COLOR = '0';
delete env.NO_COLOR;
