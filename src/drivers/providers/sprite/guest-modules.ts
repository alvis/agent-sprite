import { driverModule } from '#guest/guest-root';

/** compiled module that keeps a Sprite awake through one expiring task */
export const SPRITE_AWAKE_MODULE = driverModule(
  'providers/sprite',
  'sprite-awake.js',
);
