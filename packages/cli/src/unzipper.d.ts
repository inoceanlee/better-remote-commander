declare module 'unzipper' {
  export interface ZipEntry {
    path: string;
    type: 'File' | 'Directory';
    uncompressedSize: number;
    stream(): NodeJS.ReadableStream;
  }

  export interface Directory {
    files: ZipEntry[];
  }

  const unzipper: {
    Open: {
      buffer(buffer: Buffer): Promise<Directory>;
      file(filename: string): Promise<Directory>;
    };
  };

  export default unzipper;
}
