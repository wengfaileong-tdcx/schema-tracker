/* ============================================================
   THIS IS THE ONLY FILE YOU EDIT.

   One entry per URL. Inside each, one entry per version,
   NEWEST FIRST. Paste the schema as a normal JSON object
   (no <script> tags, no quotes around it).

   The dashboard works out the change summary and the diff
   by comparing each version against the one below it.

   The content below is EXAMPLE DATA - replace it with yours.
   ============================================================ */

window.SCHEMA_HISTORY = {

  site: "example.com",

  pages: [

    /* ---------------------------------------------------- */
    {
      url: "/",
      title: "Homepage",
      status: "Live",
      versions: [
        {
          version: "v1.4",
          date: "2026-07-14",
          schema: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Brand",
                "@id": "https://example.com/#brand",
                "name": "Example Co",
                "url": "https://example.com/",
                "logo": {
                  "@type": "ImageObject",
                  "url": "https://example.com/logo.svg",
                  "width": 185,
                  "height": 37
                },
                "sameAs": [
                  "https://www.linkedin.com/company/example",
                  "https://www.facebook.com/example/",
                  "https://www.instagram.com/example/",
                  "https://www.youtube.com/@example",
                  "https://x.com/example",
                  "https://www.tiktok.com/@example"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://example.com/#organization",
                "name": "Example Co",
                "legalName": "Example Company Ltd.",
                "url": "https://example.com/",
                "identifier": {
                  "@type": "PropertyValue",
                  "propertyID": "CompanyID",
                  "value": "000000000X"
                },
                "foundingDate": "2026-04-09",
                "address": {
                  "@type": "PostalAddress",
                  "streetAddress": "1 Example Street",
                  "addressLocality": "Example City",
                  "postalCode": "00000",
                  "addressCountry": "US"
                },
                "contactPoint": {
                  "@type": "ContactPoint",
                  "contactType": "Enquiry",
                  "email": "hello@example.com",
                  "telephone": "+1 555 0100"
                },
                "brand": { "@id": "https://example.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Alex Example",
                  "jobTitle": "Chief Executive Officer",
                  "sameAs": ["https://www.linkedin.com/in/alexexample"]
                }
              }
            ]
          }
        },
        {
          version: "v1.3",
          date: "2026-06-23",
          schema: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Brand",
                "@id": "https://example.com/#brand",
                "name": "Example Co",
                "url": "https://example.com/",
                "logo": {
                  "@type": "ImageObject",
                  "url": "https://example.com/logo.png"
                },
                "sameAs": [
                  "https://www.linkedin.com/company/example",
                  "https://www.facebook.com/example/",
                  "https://www.instagram.com/example/",
                  "https://www.youtube.com/@example",
                  "https://x.com/example",
                  "https://www.tiktok.com/@example"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://example.com/#organization",
                "name": "Example Co",
                "url": "https://example.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Example City",
                  "addressCountry": "US"
                },
                "brand": { "@id": "https://example.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Alex Example",
                  "jobTitle": "Chief Executive Officer"
                }
              }
            ]
          }
        },
        {
          version: "v1.2",
          date: "2026-06-10",
          schema: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Brand",
                "@id": "https://example.com/#brand",
                "name": "Example Co",
                "url": "https://example.com/",
                "sameAs": [
                  "https://www.linkedin.com/company/example",
                  "https://www.facebook.com/example/",
                  "https://www.instagram.com/example/",
                  "https://www.youtube.com/@example",
                  "https://x.com/example",
                  "https://www.tiktok.com/@example"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://example.com/#organization",
                "name": "Example Co",
                "url": "https://example.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Example City",
                  "addressCountry": "US"
                },
                "brand": { "@id": "https://example.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Alex Example",
                  "jobTitle": "Chief Executive Officer"
                }
              }
            ]
          }
        },
        {
          version: "v1.1",
          date: "2026-05-28",
          note: "First tracked version.",
          schema: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                "@id": "https://example.com/#organization",
                "name": "Example Co",
                "url": "https://example.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Example City",
                  "addressCountry": "US"
                },
                "sameAs": [
                  "https://www.linkedin.com/company/example",
                  "https://www.facebook.com/example/"
                ],
                "founder": {
                  "@type": "Person",
                  "name": "Alex Example",
                  "jobTitle": "Chief Executive Officer"
                }
              }
            ]
          }
        }
      ]
    },

    /* ---------------------------------------------------- */
    {
      url: "/verify/example",
      title: "Verify",
      status: "Live",
      versions: [
        {
          version: "v1.2",
          date: "2026-06-23",
          schema: {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": "https://example.com/verify/example#webpage",
            "name": "Verify Example Co",
            "url": "https://example.com/verify/example",
            "isPartOf": { "@id": "https://example.com/#website" },
            "breadcrumb": {
              "@type": "BreadcrumbList",
              "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://example.com/" },
                { "@type": "ListItem", "position": 2, "name": "Verify" }
              ]
            }
          }
        },
        {
          version: "v1.1",
          date: "2026-05-28",
          schema: {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": "https://example.com/verify/example#webpage",
            "name": "Verify Example Co",
            "url": "https://example.com/verify/example"
          }
        }
      ]
    },

    /* ---------------------------------------------------- */
    {
      url: "/policies/terms-of-use",
      title: "Terms of use",
      status: "Draft",
      versions: [
        {
          version: "v1.0",
          date: "2026-05-28",
          schema: {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": "https://example.com/policies/terms-of-use#webpage",
            "name": "Terms of Use",
            "url": "https://example.com/policies/terms-of-use"
          }
        }
      ]
    }

  ]
};
