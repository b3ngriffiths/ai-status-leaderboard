import type { Company, Product } from './types'

// A company uses title routing when it declares title_skip or any product
// declares title_keywords. In that mode, incidents without component links are
// attributed to a product by matching the incident title.
export function isTitleRouted(company: Company): boolean {
  return (
    !!company.title_skip?.length ||
    company.products.some((p) => p.title_keywords?.length)
  )
}

// Match an incident title to a product (or null to drop it). Returns the first
// product whose title_keywords match; falls back to the first product.
export function routeByTitle(company: Company, title: string): Product | null {
  const haystack = title.toLowerCase()
  if (company.title_skip?.some((kw) => haystack.includes(kw.toLowerCase()))) {
    return null // explicitly excluded product line (e.g. FedRAMP)
  }
  const match = company.products.find((p) =>
    p.title_keywords?.some((kw) => haystack.includes(kw.toLowerCase())),
  )
  return match ?? company.products[0]
}
