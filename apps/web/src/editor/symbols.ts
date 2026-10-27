/** A symbol of the palette: what to insert, how it looks, the package it needs. */
export interface PaletteSymbol {
  /** Inserted text: the command, with empty braces for its arguments. */
  command: string;
  glyph: string;
  category: SymbolCategory;
  package: string | null;
}

export const symbolCategories = [
  'greek',
  'operators',
  'relations',
  'arrows',
  'sets',
  'accents',
  'delimiters',
  'text',
] as const;
export type SymbolCategory = (typeof symbolCategories)[number];

/** `name glyph [package]`, separated by `;`: short to read and to review. */
const TABLE: Readonly<Record<SymbolCategory, string>> = {
  greek:
    'alpha α;beta β;gamma γ;delta δ;epsilon ϵ;varepsilon ε;zeta ζ;eta η;theta θ;' +
    'vartheta ϑ;iota ι;kappa κ;varkappa ϰ amssymb;lambda λ;mu μ;nu ν;xi ξ;pi π;' +
    'varpi ϖ;rho ρ;varrho ϱ;sigma σ;varsigma ς;tau τ;upsilon υ;phi ϕ;varphi φ;chi χ;' +
    'psi ψ;omega ω;Gamma Γ;Delta Δ;Theta Θ;Lambda Λ;Xi Ξ;Pi Π;Sigma Σ;Upsilon Υ;' +
    'Phi Φ;Psi Ψ;Omega Ω;digamma ϝ amssymb',
  operators:
    'pm ±;mp ∓;times ×;div ÷;cdot ⋅;ast ∗;star ⋆;circ ∘;bullet ∙;oplus ⊕;ominus ⊖;' +
    'otimes ⊗;oslash ⊘;odot ⊙;cap ∩;cup ∪;sqcap ⊓;sqcup ⊔;vee ∨;wedge ∧;setminus ∖;' +
    'wr ≀;dagger †;ddagger ‡;amalg ⨿;uplus ⊎;triangleleft ◃;triangleright ▹;' +
    'bigtriangleup △;bigtriangledown ▽;sum ∑;prod ∏;coprod ∐;int ∫;iint ∬ amsmath;' +
    'iiint ∭ amsmath;oint ∮;bigcup ⋃;bigcap ⋂;bigoplus ⨁;bigotimes ⨂;bigodot ⨀;' +
    'bigvee ⋁;bigwedge ⋀;biguplus ⨄;sqrt{} √;frac{}{} ½;partial ∂;nabla ∇;infty ∞;' +
    'ltimes ⋉ amssymb;rtimes ⋊ amssymb;boxplus ⊞ amssymb;boxtimes ⊠ amssymb',
  relations:
    'leq ≤;geq ≥;neq ≠;equiv ≡;approx ≈;cong ≅;sim ∼;simeq ≃;propto ∝;ll ≪;gg ≫;' +
    'prec ≺;succ ≻;preceq ⪯;succeq ⪰;subset ⊂;supset ⊃;subseteq ⊆;supseteq ⊇;' +
    'subsetneq ⊊ amssymb;supsetneq ⊋ amssymb;sqsubseteq ⊑;sqsupseteq ⊒;in ∈;ni ∋;' +
    'notin ∉;perp ⊥;parallel ∥;mid ∣;nmid ∤ amssymb;models ⊨;vdash ⊢;dashv ⊣;asymp ≍;' +
    'doteq ≐;bowtie ⋈;leqslant ⩽ amssymb;geqslant ⩾ amssymb;lesssim ≲ amssymb;' +
    'gtrsim ≳ amssymb;triangleq ≜ amssymb;coloneqq ≔ mathtools;ncong ≇ amssymb;' +
    'nsim ≁ amssymb',
  arrows:
    'leftarrow ←;rightarrow →;leftrightarrow ↔;Leftarrow ⇐;Rightarrow ⇒;' +
    'Leftrightarrow ⇔;longleftarrow ⟵;longrightarrow ⟶;longleftrightarrow ⟷;' +
    'Longleftarrow ⟸;Longrightarrow ⟹;Longleftrightarrow ⟺;mapsto ↦;longmapsto ⟼;' +
    'uparrow ↑;downarrow ↓;updownarrow ↕;Uparrow ⇑;Downarrow ⇓;Updownarrow ⇕;' +
    'nearrow ↗;searrow ↘;swarrow ↙;nwarrow ↖;hookleftarrow ↩;hookrightarrow ↪;' +
    'leftharpoonup ↼;rightharpoonup ⇀;rightleftharpoons ⇌;implies ⟹ amsmath;' +
    'iff ⟺ amsmath;to →;gets ←;leadsto ⇝ amssymb;twoheadrightarrow ↠ amssymb;' +
    'rightsquigarrow ⇝ amssymb;circlearrowleft ↺ amssymb;circlearrowright ↻ amssymb;' +
    'xrightarrow{} ⟶ amsmath;xleftarrow{} ⟵ amsmath',
  sets:
    'emptyset ∅;varnothing ∅ amssymb;mathbb{N} ℕ amssymb;mathbb{Z} ℤ amssymb;' +
    'mathbb{Q} ℚ amssymb;mathbb{R} ℝ amssymb;mathbb{C} ℂ amssymb;forall ∀;exists ∃;' +
    'nexists ∄ amssymb;neg ¬;land ∧;lor ∨;top ⊤;bot ⊥;aleph ℵ;beth ℶ amssymb;' +
    'complement ∁ amssymb;Re ℜ;Im ℑ;wp ℘;ell ℓ;hbar ℏ;imath ı;jmath ȷ;' +
    'therefore ∴ amssymb;because ∵ amssymb;square □ amssymb;blacksquare ■ amssymb;' +
    'Diamond ◇ amssymb;angle ∠;measuredangle ∡ amssymb;triangle △;clubsuit ♣;' +
    'diamondsuit ♢;heartsuit ♡;spadesuit ♠;flat ♭;natural ♮;sharp ♯;' +
    'checkmark ✓ amssymb;dots …;cdots ⋯;vdots ⋮;ddots ⋱;prime ′;degree ° gensymb',
  accents:
    'hat{} â;check{} ǎ;tilde{} ã;acute{} á;grave{} à;dot{} ȧ;ddot{} ä;breve{} ă;' +
    'bar{} ā;vec{} a⃗;widehat{} â;widetilde{} ã;overline{} a̅;underline{} a̲;' +
    'overrightarrow{} a⃗;overbrace{} ⏞;underbrace{} ⏟;mathring{} å;' +
    'dddot{} a⃛ amsmath',
  delimiters:
    'langle ⟨;rangle ⟩;lfloor ⌊;rfloor ⌋;lceil ⌈;rceil ⌉;lvert | amsmath;' +
    'rvert | amsmath;lVert ‖ amsmath;rVert ‖ amsmath;{ {;} };ulcorner ⌜ amssymb;' +
    'urcorner ⌝ amssymb;llbracket ⟦ stmaryrd;rrbracket ⟧ stmaryrd;left( (;right) )',
  text:
    'S §;P ¶;copyright ©;textregistered ®;texttrademark ™;euro € eurosym;pounds £;' +
    'textdegree ° textcomp;ldots …;textbullet •;textendash –;textemdash —;' +
    'guillemotleft «;guillemotright »;textperthousand ‰ textcomp;og{} « babel;' +
    'fg{} » babel',
};

/** Every symbol of the palette. */
export const PALETTE: readonly PaletteSymbol[] = symbolCategories.flatMap((category) =>
  TABLE[category].split(';').map((entry) => {
    const [name = '', glyph = '', pkg] = entry.split(' ');
    return { command: `\\${name}`, glyph, category, package: pkg ?? null };
  }),
);

/** Symbols whose command or category matches `query`; all of them for an empty query. */
export function searchSymbols(query: string, category: SymbolCategory | null): PaletteSymbol[] {
  const needle = query.trim().replace(/^\\/, '').toLowerCase();
  return PALETTE.filter(
    (symbol) =>
      (category === null || symbol.category === category) &&
      (needle === '' ||
        symbol.command.slice(1).toLowerCase().includes(needle) ||
        symbol.glyph === needle),
  );
}
