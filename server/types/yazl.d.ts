declare module 'yazl' {
  type AddOptions = {
    compress?: boolean;
  };

  class ZipFile {
    outputStream: NodeJS.ReadableStream;
    addBuffer(buffer: Buffer, metadataPath: string, options?: AddOptions): void;
    end(): void;
  }

  const yazl: {
    ZipFile: typeof ZipFile;
  };

  export = yazl;
}
