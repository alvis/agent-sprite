import { driverModule } from '#guest/guest-root';

/** compiled module that suspends or stops a Fly Machine from inside */
export const FLY_MACHINE_AWAKE_MODULE = driverModule(
  'providers/fly-machine',
  'fly-machine-awake.js',
);
