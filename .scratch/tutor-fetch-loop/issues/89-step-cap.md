# 89 — Tutor loops on web fetches and hits the 40-step cap

Status: needs a GitHub comment. `gh issue comment` was refused (`Resource not accessible by integration`). Leave the issue open.

GitHub: https://github.com/JonathanHarris15/Groundwork/issues/89

## Comments

The step-cap failure is fixed in #92, merged as 14b2fcf, and shipping in plugin 0.1.17.

The chapter page was the reason it looped. `fetch_public` returned the first 12,000 characters of raw HTML, which on bayesrulesbook.com is the table of contents plus a `github-repo` meta tag. Equation 6.2 and the coding assignments sit much later, so the model kept fetching the book and then GitHub and never answered.

What changed:

- A page is turned into readable text, starting at the `#fragment` when the URL has one. Fetching the same URL again returns that text and does not hit the network. A host is refused after three distinct fetches.
- A turn gets six web reads. After that, fetch and search tools are removed and the model is told to answer with what it has.
- The last three steps have no tools. That covers a long quiz, not only web fetches. "I have a Calc 1 final Dec 9, help me study" now gets a wrap-up instead of another question.
- If the cap is still hit, the chat shows a partial answer and a Continue button. It does not say "Stopped after 40 steps without finishing."

A live Heavy turn of the Bayes Rules prompt finished in 3 steps and 1 fetch, with the 501-point grid and the 4-chain Stan model. Light finished in 2 steps and 1 fetch. Leaving this open for you.
