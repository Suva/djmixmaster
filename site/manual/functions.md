# Formula reference

Everything a [formula](formulas.md) can use: the functions, the values the music gives, and, for text, the variables.

## Functions

Phases go from 0 to 1 and repeat: `beats`, `beatPhase` and `barPhase` are made for them, as are `time / 8` and the like.

{{functions}}

## Music values

The bands, the level and the energy are scaled to the mix's own range, so a quiet mix moves the picture as much as a loud one.

{{music}}

## Text variables

Text is written with variables between percent signs, such as `%artist%`, which fill themselves in. `%%` gives a percent sign. A [field](fields.md) is written the same way: `%venue%`.

{{text-variables}}
