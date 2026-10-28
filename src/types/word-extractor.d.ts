declare module 'word-extractor' {
  export class Document {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
  }
  export default class WordExtractor {
    extract(input: string | Buffer): Promise<Document>;
  }
}
