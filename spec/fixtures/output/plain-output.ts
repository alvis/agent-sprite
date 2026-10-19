import { env } from 'node:process';

// terminal styling is decided when the renderer first loads, so goldens pin the
// unstyled text no matter how the runner colors its own output
env.FORCE_COLOR = '0';
delete env.NO_COLOR;
