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

  site: "llmsource.com",

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
                "@id": "https://llmsource.com/#brand",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "logo": {
                  "@type": "ImageObject",
                  "url": "https://llmsource.com/LLMSource-Logo.svg",
                  "width": 185,
                  "height": 37
                },
                "sameAs": [
                  "https://www.linkedin.com/company/llmsource",
                  "https://www.facebook.com/llmsource/",
                  "https://www.instagram.com/llmsource/",
                  "https://www.youtube.com/@llmsource",
                  "https://x.com/LLMSource",
                  "https://www.tiktok.com/@llmsource"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://llmsource.com/#organization",
                "name": "LLMSource",
                "legalName": "LLMSOURCE PTE. LTD.",
                "url": "https://llmsource.com/",
                "identifier": {
                  "@type": "PropertyValue",
                  "propertyID": "UEN",
                  "value": "202615639N"
                },
                "foundingDate": "2026-04-09",
                "address": {
                  "@type": "PostalAddress",
                  "streetAddress": "750D Chai Chee Road #06-01 ESR Biz Chee",
                  "addressLocality": "Singapore",
                  "postalCode": "469004",
                  "addressCountry": "SG"
                },
                "contactPoint": {
                  "@type": "ContactPoint",
                  "contactType": "Enquiry",
                  "email": "enquiry@llmsource.com",
                  "telephone": "+65 6216 1390"
                },
                "brand": { "@id": "https://llmsource.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Laurent Junique",
                  "jobTitle": "Chief Executive Officer",
                  "sameAs": ["https://www.linkedin.com/in/laurentjunique"]
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
                "@id": "https://llmsource.com/#brand",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "logo": {
                  "@type": "ImageObject",
                  "url": "https://llmsource.com/logo.png"
                },
                "sameAs": [
                  "https://www.linkedin.com/company/llmsource",
                  "https://www.facebook.com/llmsource/",
                  "https://www.instagram.com/llmsource/",
                  "https://www.youtube.com/@llmsource",
                  "https://x.com/LLMSource",
                  "https://www.tiktok.com/@llmsource"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://llmsource.com/#organization",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Singapore",
                  "addressCountry": "SG"
                },
                "brand": { "@id": "https://llmsource.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Laurent Junique",
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
                "@id": "https://llmsource.com/#brand",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "sameAs": [
                  "https://www.linkedin.com/company/llmsource",
                  "https://www.facebook.com/llmsource/",
                  "https://www.instagram.com/llmsource/",
                  "https://www.youtube.com/@llmsource",
                  "https://x.com/LLMSource",
                  "https://www.tiktok.com/@llmsource"
                ]
              },
              {
                "@type": "Organization",
                "@id": "https://llmsource.com/#organization",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Singapore",
                  "addressCountry": "SG"
                },
                "brand": { "@id": "https://llmsource.com/#brand" },
                "founder": {
                  "@type": "Person",
                  "name": "Laurent Junique",
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
                "@id": "https://llmsource.com/#organization",
                "name": "LLMSource",
                "url": "https://llmsource.com/",
                "foundingDate": "2026",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Singapore",
                  "addressCountry": "SG"
                },
                "sameAs": [
                  "https://www.linkedin.com/company/llmsource",
                  "https://www.facebook.com/llmsource/"
                ],
                "founder": {
                  "@type": "Person",
                  "name": "Laurent Junique",
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
      url: "/verify/llmsource",
      title: "Verify",
      status: "Live",
      versions: [
        {
          version: "v1.2",
          date: "2026-06-23",
          schema: {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": "https://llmsource.com/verify/llmsource#webpage",
            "name": "Verify LLMSource",
            "url": "https://llmsource.com/verify/llmsource",
            "isPartOf": { "@id": "https://llmsource.com/#website" },
            "breadcrumb": {
              "@type": "BreadcrumbList",
              "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://llmsource.com/" },
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
            "@id": "https://llmsource.com/verify/llmsource#webpage",
            "name": "Verify LLMSource",
            "url": "https://llmsource.com/verify/llmsource"
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
            "@id": "https://llmsource.com/policies/terms-of-use#webpage",
            "name": "Terms of Use",
            "url": "https://llmsource.com/policies/terms-of-use"
          }
        }
      ]
    }

  ]
};
