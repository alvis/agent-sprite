/** flushes final output before process listeners or the launcher exit */
export async function flushOutput(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      async (stream) =>
        new Promise<void>((resolve, reject) => {
          stream.write('', (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
}
