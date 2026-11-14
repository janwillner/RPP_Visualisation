# Recipe fields described by the application; machine commands as acknowledged requests

The Simulator (ADR 0020) sets the process values a machine runs with, its **recipe**: belt and robot speeds and
accelerations, picks per cycle, the product pattern of the application's own product generator. Which values a
machine has depends on its application, not on its component types, and the product pattern is entirely the
application's own (spec #40, issue #43). The Simulator also starts, stops and resets the machine, whose sequence
control is the application's.

So, in the library Syn_Config (config protocol 3, library 2.1.0):

- **The application describes its recipe fields.** One machine FB per application, `_FB_ConfigMachine`, listed in the
  config manifest with id 0 and type NONE, declares every field: its name, its group (a component's manifest id, or 0
  for the whole machine), its type (NUMBER, INTEGER, SWITCH, CHOICE with named values), unit, min, max and program
  value. The gateway reads the declarations at discovery and publishes them with the recipe's status and effective
  values in `parameters` (`recipe`); the Simulator draws its form from them, without code per application.
- **One representation for every value.** Values are kept by field index as LREAL, whatever the field's type, so the
  PLC structure is the same for every application and the gateway needs no type per application; the gateway turns a
  SWITCH into true / false and checks every value against its field before it writes.
- **The staging of the parameter sets, reused** (ADR 0017): a base version, a stage id, `bStaged` or `bReset` written
  last in one sum-write, the application's apply-allowed flag, a status with the active version, result and message,
  and the application keeping the active recipe in its own persistent variable. The whole recipe of a source has one
  version; a client writes the fields it changes and the others keep their effective values.
- **Machine commands are acknowledged requests.** `writeRecipe`'s sibling `machineCommand` writes a command id, the
  command (START, STOP, RESET) and `bRequested` last; the application takes it with `m_Command`, decides alone and
  answers with `m_AnswerCommand` (accepted, or rejected with a reason), which the gateway publishes
  (`machineCommand`). The library carries nothing out itself.
- **Only for a simulated machine.** The gateway writes a recipe or a command only with `--allow-write`, from the
  gateway's own pages, and while the PLC reports simulation mode in its machine entry (ADR 0021). A PLC of config
  protocol 2 keeps working with parameter sets only (`MIN_CONFIG_PROTOCOL_VERSION`).

## Considered Options

- **A fixed, typed recipe per component type** (a conveyor's speed and acceleration, a robot's speed, picks per
  cycle): the gateway and the Simulator would know every field, but every application's own values (its product
  pattern above all) would need a library and gateway change, and a machine without them would show fields it ignores.
- **Recipe fields per parameter FB**: they would sit with their component, but the recipe would have as many versions
  and stagings as components, and the machine-wide fields would still need a home.
- **Commands as plain flags the application reads**: no answer, so the Simulator could not tell a start the
  application refused from one that has not happened yet.

## Consequences

- Declarations are read at discovery: an application declares every field from the start and keeps their order (the
  persistent recipe keeps values by index).
- The demo application declares its recipe and handles the commands with its own product generator and sequence
  control (#46); the Simulator page binds to `recipe` and `machineCommand` (#45).

## Amendment (#49)

Many recipe fields matter only for one variant of an application (a product pattern's lane count only for "Lanes"),
and their names say little about what they are for; the Simulator showed every field all the time, labelled by its
name turned into words. The PLC keeps deciding what is settable, and now also says when a field applies and what it
is called (config protocol 4, Syn_Config 2.2.0):

- **A visibility condition per field.** `m_SetVisibleWhen(field, onField, value)`: the field is shown only while
  `onField` (a SWITCH, CHOICE or INTEGER field, in any group) has that value in the Simulator's form, i.e. its edit,
  else its active value. A field whose condition field is hidden is hidden too. A hidden field keeps its edit, which is
  written and named in the write plan, and its value in a recipe file; it is hidden, not disabled. A condition on a
  NUMBER field, on itself, on an unknown field or in a cycle is a discovery error, and the field stays visible.
- **A label and a description per field** (`m_SetText`): free text in the application's language, shown instead of
  the worded name and in the field's tooltip. The name stays the field's key for writing and for recipe files.
- **Unchanged:** `m_DeclareField`, the persistent recipe set, static declarations read at discovery, 64 fields and 8
  choices. A gateway still reads config protocol 3, whose fields have no condition or texts.

Considered and left out: declarations changing at run time (they would break the persistent recipe kept by index and
recipe files), ready-made fields per component type in the library (the fixed recipe this ADR rejected), and declared
parameter sets for the configurator (they hold geometry the 3D view must understand, so they stay fixed per component
type).
