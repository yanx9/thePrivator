import tkinter as tk

def on_entry_change(*args):
    value = entry_text.get()
    if value:  # Check if the entry is not empty
        # Perform actions based on the inserted character
        print(f"Character inserted: {value[-1]}")

# Create the main window
root = tk.Tk()

# Create a StringVar object
entry_text = tk.StringVar()

# Set up a trace on the StringVar object
entry_text.trace("w", on_entry_change)

# Create an Entry widget and associate it with the StringVar object
entry = tk.Entry(root, textvariable=entry_text)
entry.pack()

# Start the Tkinter event loop
root.mainloop()
