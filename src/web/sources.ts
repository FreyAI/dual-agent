/** Numbers sources once per conversation, so [3] means the same page throughout. */
export class SourceList {
  private numbers = new Map<string, number>();

  number(url: string): number {
    const key = url.replace(/#.*$/, '');
    let n = this.numbers.get(key);
    if (!n) {
      n = this.numbers.size + 1;
      this.numbers.set(key, n);
    }
    return n;
  }

  reset() {
    this.numbers.clear();
  }
}
