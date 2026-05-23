def greet(name):
    """Say hello."""
    print(f"Hello, {name}!")

def add(a, b):
    return a + b

class Calculator:
    def __init__(self):
        self.history = []

    def compute(self, op, a, b):
        if op == "+":
            result = a + b
        elif op == "-":
            result = a - b
        else:
            raise ValueError(op)
        self.history.append((op, a, b, result))
        return result
