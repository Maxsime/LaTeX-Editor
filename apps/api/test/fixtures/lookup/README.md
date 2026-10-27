# Answers of the bibliographic services

Answers of Crossref, arXiv and Open Library replayed by `test/bibliography.test.ts`
through a local HTTP server, so that tests never depend on the network.

They follow the formats documented by each service (Crossref REST API `/works/{doi}`,
arXiv API Atom feed, Open Library Books API `jscmd=data`), reduced to the fields
Galley reads. The metadata of `crossref-10.1093_comjnl_27.2.97.json`,
`arxiv-1706.03762.xml` and `openlibrary-9780201134476.json` is that of the real
records (Knuth, *Literate Programming*, 1984; Vaswani et al., *Attention Is All You
Need*, 2017; Knuth, *The TeXbook*, 1984). They were written from the documented
formats rather than captured byte for byte, the build environment having no access
to these hosts; refresh them with a capture when convenient (see `docs/operations.md`).
`crossref-escaping.json` is synthetic: it gathers the characters an entry must escape.
