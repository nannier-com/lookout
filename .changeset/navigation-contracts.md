---
"@nannier-com/lookout": patch
---

Groundwork for navigation discovery: the NavigationConfig surface is
validated, route fields (name, element, states, navigation) are validated
instead of cast through, and scope/pruning treat states named by
.lookout/navigation.json as configured intent. Inert until a plan exists.
