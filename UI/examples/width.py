import tkinter as tk

def insert_text():
    text_to_insert = entry.get()
    entry.insert(tk.END, text_to_insert)

# Create the main window
root = tk.Tk()
root.title("Adjust Entry Width with Grid")

# Create a frame to hold the Entry widget
frame = tk.Frame(root)
frame.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)

# Create an Entry widget inside the frame
entry = tk.Entry(frame)
entry.grid(row=0, column=0, sticky="ew", padx=10, pady=10)

# Configure row and column weights to make the frame and entry expandable
frame.columnconfigure(0, weight=1)
frame.rowconfigure(0, weight=1)

# Create a button to trigger the insertion
insert_button = tk.Button(root, text="Insert Text", command=insert_text)
insert_button.grid(row=1, column=0, pady=10)

# Run the Tkinter event loop
root.mainloop()